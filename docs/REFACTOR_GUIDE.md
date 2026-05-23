# CloudMind-Zome 重构指导

> 本文档记录已知技术债务、耦合热点和重构路线图。
> 与 `ARCHITECTURE.md`（现状描述）配合使用。

---

## 1. 技术债务总览

### 1.1 架构级债务

| 等级 | 问题 | 影响 | 建议方案 |
|------|------|------|----------|
| P0 | `ws.py` 840 行，集 WS 协议/路由/业务/持久化于一体 | 难以测试、改动风险高 | 拆分为 `protocol/`, `handlers/`, `dispatchers/` |
| P0 | `agent_worker.py` + `engine_bridge.py` 边界模糊 | 同一件事在两个文件里各做一半 | EngineBridge 只做"序列化/反序列化"，Worker 只做"调度" |
| P1 | `react.py` 直接 import `AsyncSessionLocal` 查 DB | 引擎层不应依赖平台层 | 通过回调/接口注入 DB 操作 |
| P1 | `main.py` 的 `_app_state` 全局字典 | 类型不安全，隐式依赖 | 改为 TypedDict 或 dataclass， lifespan 只初始化一次 |
| P1 | `engine/config.yaml` 与 `app/api/config.py` 双头管理 | 配置源不一致 | 统一配置中心，平台只提供 HTTP 代理 |
| P2 | `chat_messages` 和 `agent_messages` 双写 | 数据冗余、一致性问题 | 明确分工：chat_messages = 平台展示，agent_messages = Agent 记忆 |
| P2 | `_stream_text` 模拟流式 | 延迟不自然，大文本卡顿 | 迁移到真正的 `transport.stream()` |

### 1.2 代码级债务

| 文件 | 坏味道 | 重构手法 |
|------|--------|----------|
| `ws.py` | 超长函数 `_handle_chat_send` | Extract Method：拆分为 `save_message()`, `route_private()`, `route_group()` |
| `ws.py` | 多个 `_build_ws_frame` 重复构造 | Extract Class：`WSFrameBuilder` |
| `agent_worker.py` | `_build_transport()` 200 行内联 | Extract Method / Move Method：移至 `provider_factory.py` |
| `react.py` | `_build_messages()` 负责 tag + scene + format | Split：tag 逻辑移至 `MessageTagger`，scene 移至 `SceneBuilder` |
| `session/store.py` | 3 套几乎相同的 load/save 逻辑 | Template Method：统一 `save_blocks()` / `load_blocks()` |
| `transport.py` | `_normalize_response()` 与 `stream()` 工具调用解析重复 | Extract：统一 `ToolCallParser` |

---

## 2. 耦合热点分析

### 2.1 模块依赖图（问题区域）

```
                    ┌─────────────┐
                    │   ws.py     │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │EngineBridge│  │GroupChat   │  │Conductor   │
    └──────┬─────┘  │Router      │  │Service     │
           │        └──────┬─────┘  └─────┬──────┘
           │               │              │
           ▼               ▼              ▼
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │AgentWorker │  │  models    │  │  models    │
    └──────┬─────┘  └────────────┘  └────────────┘
           │
           ▼
    ┌────────────┐
    │ ReActAgent │◄──────┐
    └──────┬─────┘       │
           │              │
           ▼              │
    ┌────────────┐       │
    │ transport  │       │ 直接 import platform DB!
    └────────────┘       │
           ▲             │
           │             │
    ┌────────────┐       │
    │ store.py   │───────┘
    └────────────┘
```

**红色警报：`engine/` 目录下的代码不应该 import `app/` 目录下的任何模块。**

### 2.2 当前违规依赖

```bash
# engine 层 import app 层（不应该）
engine/agent/react.py       → app/database.py (AsyncSessionLocal)
engine/session/store.py     → app/database.py (间接，通过 cloudmind.db 路径)
engine/provider/transport.py → (已清理，当前干净)
```

**修复方案：**
- `react.py` 中的 `_save_message` 不应直接操作 DB。改为回调模式：
  ```python
  class ReActAgent:
      def __init__(..., on_persist: Callable[[Message], Awaitable[None]] | None = None):
          self._on_persist = on_persist
  ```
- 平台层在创建 ReActAgent 时注入：`on_persist=session_store.save_agent_message`

---

## 3. 重构路线图

### Phase 1: 解耦引擎层（1-2 天）

**目标：** `engine/` 目录零依赖 `app/`

- [ ] `react.py` 移除 `AsyncSessionLocal` import，改为回调注入
- [ ] `agent_worker.py` 的 `_build_transport()` 移至 `engine/provider/factory.py`
- [ ] `engine/session/store.py` 独立配置 DB 路径，不依赖 `app/` 的常量

**验证：** `grep -r "from app\." backend/engine/` 返回空

### Phase 2: WS 协议拆分（2-3 天）

**目标：** `ws.py` < 200 行，只留连接管理和分发

```
app/api/ws/
├── __init__.py          # router export
├── connection.py        # WebSocket connect/disconnect/heartbeat
├── dispatcher.py        # frame 路由分发
├── handlers/
│   ├── chat.py          # chat.send 处理
│   ├── agent.py         # agent.stop 处理
│   └── system.py        # typing, status 订阅
└── frames.py            # WSFrameBuilder + 协议常量
```

### Phase 3: Agent 核心瘦身（2-3 天）

**目标：** `react.py` 只留 ReAct 循环，其他拆出去

```
engine/agent/
├── react.py             # ReAct 循环（精简到 200 行）
├── memory/
│   ├── builder.py       # _build_messages, tag injection, scene injection
│   ├── tagger.py        # _tag_prefix, _tag_message
│   └── compressor.py    # 调用 ContextManager 的包装
└── prompt/
    └── builder.py       # personality + scene + guard 拼接
```

### Phase 4: 真流式迁移（3-5 天）

**目标：** Agent 回复像 ChatGPT 一样逐字流出

```
当前: LLM.chat() → 等完整响应 → _stream_text() 逐字推
目标: LLM.stream() → 每收到一个 token 立即推

挑战:
1. stream() 模式下 tool_calls 在最后一个 chunk 才完整
2. 需要重构 react.py 的 "检查 tool_calls" 逻辑
3. error recovery / fallback 需要适配流式中断
```

### Phase 5: 测试覆盖（持续）

**目标：** 核心路径有单元测试

| 模块 | 测试重点 |
|------|----------|
| `transport.py` | format 一致性（tool_use/tool_result id 匹配） |
| `react.py` | ReAct 循环终止条件（SmartStop） |
| `tool/registry.py` | schema 生成、工具执行超时 |
| `group_chat_router.py` | @mention 提取、语义路由 |
| `ws.py` | frame 序列化/反序列化 |

---

## 4. 接口契约（层间边界）

### 4.1 平台层 ↔ 引擎层

```python
# 平台层调用引擎层（允许）
from engine.agent.react import ReActAgent
from engine.provider.transport import ChatCompletionsTransport
from engine.tool.registry import tool_registry

# 引擎层调用平台层（禁止）
from app.database import AsyncSessionLocal      # ❌
from app.models import Agent                     # ❌
```

### 4.2 EngineBridge 契约

```python
class EngineBridge:
    """平台 → 引擎的唯一入口。

    职责：
      1. 将平台请求序列化为 AgentJob
      2. 将引擎事件反序列化为平台 WS 帧
      3. 不做任何业务决策
    """
    async def stream_chat(...) -> AsyncIterator[dict]: ...
    async def run_sync(...) -> str: ...
```

### 4.3 AgentWorker 契约

```python
class AgentWorker:
    """引擎调度层。

    职责：
      1. 维护单 Agent 的 Task + Queue
      2. 状态机：idle → busy → idle
      3. 内省调度（空闲压缩）
    """
    async def run(self) -> None: ...      # 消费队列
    def stop(self) -> None: ...          # 信号关闭
```

### 4.4 ReActAgent 契约

```python
class ReActAgent:
    """纯逻辑层，无 IO（除 LLM 调用）。

    职责：
      1. ReAct 循环
      2. _messages 内存管理
      3. 调用 toolkit.execute()（异步 IO）
    """
    async def stream(...) -> AsyncIterator[AgentEvent]: ...
```

---

## 5. 数据流详细时序

### 5.1 私聊完整链路

```
User        Frontend    WS        Platform    EngineBridge    AgentWorker    ReActAgent    LLM API
 │             │         │            │              │              │              │           │
 │──input───▶│         │            │              │              │              │           │
 │             │──WS───▶│            │              │              │              │           │
 │             │        │──save msg─▶│              │              │              │           │
 │             │        │            │──Job────────▶│              │              │           │
 │             │        │            │              │──enqueue───▶ │              │           │
 │             │        │            │              │              │──Job───────▶ │           │
 │             │        │            │              │              │              │──prompt──▶│
 │             │        │            │              │              │              │◀──token──│
 │             │◀──WS───│◀───────────│◀─────────────│◀─────────────│◀──chunk─────│           │
 │◀─render───│         │            │              │              │              │           │
 │             │        │            │              │              │              │◀──done───│
 │             │        │            │              │              │              │──persist─▶│
 │             │        │            │              │              │              │ (session  │
 │             │        │            │              │              │              │  store)   │
```

### 5.2 群聊完整链路

```
User        Frontend    WS        Platform        GroupChatRouter    EngineBridge    ...
 │             │         │            │                   │                │
 │──input───▶│         │            │                   │                │
 │             │──WS───▶│            │                   │                │
 │             │        │──save msg─▶│                   │                │
 │             │        │            │──route()─────────▶│                │
 │             │        │            │                   │──for each─────▶│
 │             │        │            │                   │  selected      │──▶ AgentWorker x N
 │             │◀──WS───│◀───────────│◀──────────────────│◀───────────────│◀── chunks
 │◀─render───│         │            │                   │                │
 │             │        │            │                   │──sync memory──▶│ (other agents)
```

---

## 6. 配置加载顺序

```
1. 启动 run.py
2. load_config("engine/config.yaml")
   ├── 读取 YAML
   ├── ${ENV_VAR} 替换
   └── Pydantic 验证 → AppConfig
3. main.py lifespan
   ├── Base.metadata.create_all()  # 平台表
   ├── SessionStore.connect()      # 引擎表 (agent_messages)
   ├── tool_registry.discover()    # 扫描 engine/tools/
   ├── 构建 assistant_transport
   ├── 构建 embedder + memory_store
   ├── 构建 ContextManager
   └── 启动 scheduler + wake_scheduler
```

**关键：** `engine/config.yaml` 是单一真相源。`app/api/config.py` 的 PUT 只修改这个文件。

---

## 7. 已知性能瓶颈

| 瓶颈 | 原因 | 临时方案 | 根治方案 |
|------|------|----------|----------|
| Agent 首次回复慢 | Worker 冷启动（查 DB + 建 Transport） | 无 | Worker 预启动或连接池 |
| 群聊多 Agent 并行 | N 个 Agent 同时查 DB、调 LLM | 并发控制 3 个 | 引入优先级队列 |
| 图片 base64 传输 | 大图片导致 WS 帧过大 | 限制 5MB | 图片 CDN + 缩略图 |
| 记忆加载慢 | 1000 条历史全加载 | 限制 1000 条 | 分页加载 + 语义预加载 |
| 向量检索慢 | ChromaDB 本地文件 | 单用户够用 | 迁移 Milvus/Pinecone |

---

## 8. 安全模型

虽然无登录，但仍需注意：

| 风险 | 现状 | 建议 |
|------|------|------|
| 文件系统逃逸 | `write_file` 有路径白名单 | 增加 chroot 或沙箱 |
| 代码执行 | `python_execute` / `shell_command` | 增加确认弹窗或禁用开关 |
| API Key 泄露 | 存在 config.yaml | 支持环境变量覆盖 |
| WS 无鉴权 | 任意客户端可连接 | 增加简单 token（即使 guest 也验证） |
| SQLite 并发 | WAL 模式但单进程 | 生产环境迁移 PostgreSQL |

---

## 9. 重构检查清单

在开始任何重构前，确认：

- [ ] 当前分支编译通过（`py_compile` + `vue-tsc`）
- [ ] 当前分支可启动（后端 8849 + 前端 1420）
- [ ] `/api/v1/auth/me` 返回 200
- [ ] Agent 列表 API 返回数据
- [ ] 至少完成一轮私聊测试（发送消息 → Agent 回复）
- [ ] 至少完成一轮群聊测试
- [ ] git commit 保存当前状态（方便回滚）

重构后验证：

- [ ] 上述所有检查项仍通过
- [ ] 无新增 `engine/` → `app/` 的 import
- [ ] 被修改文件的行数减少或职责更清晰
