# CloudMind-Zome 重构指导

> 本文档记录已知技术债务、耦合热点和重构路线图。
> 与 `ARCHITECTURE.md`（现状描述）配合使用。

---

## 1. 技术债务总览

### 1.1 架构级债务

| 等级 | 问题 | 影响 | 状态 | 建议方案 |
|------|------|------|------|----------|
| P0 | `ws_handlers.py` 集 WS 协议/路由/业务/持久化于一体 | 难以测试、改动风险高 | ✅ 已拆分 | 拆分为 `protocol/` + `handlers/`（ws.py 只留路由分发） |
| P0 | `ContextManager` 死代码未清理 | 误导新开发者 | ✅ 已清理 | 删除 `engine/context/manager.py`，更新所有引用 |
| P0 | `agent_worker.py` + `engine_bridge.py` 边界模糊 | 同一件事在两个文件里各做一半 | ✅ 已优化 | EngineBridge 只做"序列化/反序列化"，Worker 只做"调度" |
| P1 | `react.py` 直接 import `AsyncSessionLocal` 查 DB | 引擎层不应依赖平台层 | ⚠️ 部分修复 | `session_store` 已注入，但 `_save_message` 仍通过 `session_store` 间接操作 DB |
| P1 | `main.py` 的 `_app_state` 全局字典 | 类型不安全，隐式依赖 | 待处理 | 改为 TypedDict 或 dataclass，lifespan 只初始化一次 |
| P1 | `engine/config.yaml` 与 `app/api/config.py` 双头管理 | 配置源不一致 | 待处理 | 统一配置中心，平台只提供 HTTP 代理 |
| P2 | `chat_messages` 和 `agent_messages` 双写 | 数据冗余、一致性问题 | 待处理 | 明确分工：`chat_messages` = 平台展示，`agent_messages` = Agent 记忆 |
| P2 | `_stream_text` 模拟流式 | 延迟不自然，大文本卡顿 | ✅ 已修复 | 迁移到真正的 `transport.stream()` |

### 1.2 代码级债务

| 文件 | 坏味道 | 状态 | 重构手法 |
|------|--------|------|----------|
| `ws_handlers.py` | 超长函数 `_handle_chat_send` | ✅ 已优化 | Extract Method：拆分为 `save_message()`, `route_private()`, `route_group()` |
| `ws_handlers.py` | 多个 `_build_ws_frame` 重复构造 | ✅ 已提取 | Extract Class：`WSFrameBuilder` 在 `ws_protocol.py` |
| `agent_worker.py` | `_build_transport()` 200 行内联 | ⚠️ 已简化 | AgentWorker 不再内联构建 transport，改为 `_build_transport` 方法 + factory 模式 |
| `react.py` | `_build_messages()` 负责 tag + scene + format | ✅ 已拆分 | ContextPipeline 接管上下文组装，MessageBuilder 负责 tag + scene |
| `session/store.py` | 3 套几乎相同的 load/save 逻辑 | 待处理 | Template Method：统一 `save_blocks()` / `load_blocks()` |
| `transport.py` | `_normalize_response()` 与 `stream()` 工具调用解析重复 | 待处理 | Extract：统一 `ToolCallParser` |

---

## 2. 已完成重构

### 2.1 Context Pipeline 重构（2026-06-02）

**背景**：旧 `ContextManager` 按 "hot/warm/cold" 分层注入记忆，但存在以下问题：
- 私聊和群聊的 Hot Context 混合，导致无关消息干扰
- 语义检索只搜当前场景，跨场景记忆无法召回
- 无 token 超限保护，容易超出模型 context window

**实现**：
- 新增 `ContextPipeline`（`engine/context/context_pipeline.py`）
- 4 阶段组装：Retriever → Scorer → Assembler → Downgrade
- L1-L6 优先级分层，超限时 L5→L4→L3 逐层降级
- zvec 跨场景语义检索 + 时间衰减打分

**文件变更**：
- 新增：`engine/context/context_pipeline.py`
- 修改：`engine/agent/react.py`（Step 1 调用 Pipeline）
- 修改：`engine/config/models.py`（新增 ContextConfig 字段）
- 修改：`engine/context/vector_store.py`（增加 timestamp 字段）
- 修改：`engine/memory/base.py`（增加 `get_topic_candidates()`）
- 修改：`engine/memory/topic_compression/topic_memory.py`（实现 `get_topic_candidates()`）
- 删除：`engine/context/manager.py`（死代码）

### 2.2 ContextManager 死代码清理（2026-06-02）

**背景**：`ContextManager`（`engine/context/manager.py`）已被 `ContextPipeline` 完全替代，但仍有残留引用。

**清理内容**：
- 删除 `engine/context/manager.py`
- 从 `engine/context/__init__.py` 移除导出
- 从 `app/main.py` 移除初始化和 `_app_state["context_manager"]`
- 从 `app/services/engine_bridge.py` 移除构造函数参数
- 从 `app/services/agent_worker.py` 移除字段和导入
- 从 `app/api/ws_handlers.py`、`workflow_engine.py` 移除传参
- 从 `engine/agent/base.py` TYPE_CHECKING 块移除导入
- 更新 `test_e2e.py` 移除相关代码

### 2.3 真流式迁移（2026-05）

**背景**：旧代码使用 `LLM.chat()` 等完整响应，然后 `_stream_text()` 模拟流式，延迟不自然。

**实现**：
- `transport.stream()` 逐 token 推送 `ContentBlock`
- `react.py` 直接消费流式事件，yield `AgentEvent`
- 前端 `ChatView.vue` 按 `batch_id` 合并消息气泡

---

## 3. 耦合热点分析

### 3.1 模块依赖图（当前状态）

```
                    ┌─────────────┐
                    │  ws.py      │
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
    │ transport  │       │ 通过 session_store 间接操作 DB
    └────────────┘       │
           ▲             │
           │             │
    ┌────────────┐       │
    │ store.py   │───────┘
    └────────────┘
```

**当前状态**：`engine/` 目录不再直接 import `app/` 模块。
- `react.py` 通过注入的 `session_store`（`SessionStore` 类）操作数据库
- `SessionStore` 位于 `engine/session/store.py`，属于引擎层

### 3.2 遗留违规依赖

```bash
# 当前引擎层 import 平台层的情况（已清理）
# grep -r "from app\." backend/engine/  →  空
```

**历史问题已修复**：
- `react.py` 不再直接 `from app.database import AsyncSessionLocal`
- `engine_bridge.py` 的 `_build_transport()` 已改为通过 `provider/factory.py` 构建

---

## 4. 重构路线图（剩余工作）

### Phase 1: 配置中心统一（1-2 天）

**目标**：消除 `engine/config.yaml` 与 `app/api/config.py` 的双头管理

- [ ] `app/api/config.py` 的 PUT 只修改 `engine/config.yaml`
- [ ] 平台层不持有独立配置，全部代理到引擎层
- [ ] `_app_state` 改为 TypedDict

### Phase 2: WS 协议完全拆分（2-3 天）

**目标**：`ws.py` < 150 行，只留连接管理和帧路由

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

**目标**：`react.py` 只留 ReAct 循环，其他拆出去

```
engine/agent/
├── react.py             # ReAct 循环（精简到 200 行）
├── prompt/
│   └── pipeline.py      # ContextPipeline 调用封装
├── hooks.py             # on_before_llm, on_after_llm 等
└── stop.py              # SmartStop（已独立）
```

### Phase 4: 测试覆盖（持续）

**目标**：核心路径有单元测试

| 模块 | 测试重点 | 状态 |
|------|----------|------|
| `transport.py` | format 一致性（tool_use/tool_result id 匹配） | 待补充 |
| `react.py` | ReAct 循环终止条件（SmartStop） | 待补充 |
| `tool/registry.py` | schema 生成、工具执行超时 | 待补充 |
| `group_chat_router.py` | @mention 提取、语义路由 | 待补充 |
| `context_pipeline.py` | 降级逻辑、token 估算 | 已部分覆盖 |
| `vector_store.py` | zvec add/search/delete | 已部分覆盖 |

---

## 5. 接口契约（层间边界）

### 5.1 平台层 ↔ 引擎层

```python
# 平台层调用引擎层（允许）
from engine.agent.react import ReActAgent
from engine.provider.transport import ChatCompletionsTransport
from engine.tool.registry import tool_registry
from engine.context.context_pipeline import ContextPipeline

# 引擎层调用平台层（禁止）
from app.database import AsyncSessionLocal      # ❌
from app.models import Agent                     # ❌
```

**验证命令**：
```bash
grep -r "from app\." backend/engine/
# 应该返回空
```

### 5.2 EngineBridge 契约

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

### 5.3 AgentWorker 契约

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

### 5.4 ReActAgent 契约

```python
class ReActAgent:
    """纯逻辑层，无 IO（除 LLM 调用）。

    职责：
      1. ReAct 循环
      2. _messages 内存管理（场景隔离）
      3. ContextPipeline 调用
      4. toolkit.execute()（异步 IO）
    """
    async def stream(...) -> AsyncIterator[AgentEvent]: ...
```

### 5.5 ContextPipeline 契约

```python
class ContextPipeline:
    """上下文组装层。

    职责：
      1. 语义检索（zvec 跨场景）
      2. 打分过滤（时间衰减）
      3. 按优先级组装 L1-L6
      4. Token 超限降级（L5→L4→L3）
    """
    async def assemble(...) -> list[Message]: ...
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
   └── 启动 scheduler
```

**关键：** `engine/config.yaml` 是单一真相源。`app/api/config.py` 的 PUT 只修改这个文件。

---

## 7. 安全模型

虽然无登录，但仍需注意：

| 风险 | 现状 | 建议 |
|------|------|------|
| 文件系统逃逸 | `write_file` 有路径白名单 | 增加 chroot 或沙箱 |
| 代码执行 | `python_execute` / `shell_command` | 增加确认弹窗或禁用开关 |
| API Key 泄露 | 存在 config.yaml | 支持环境变量覆盖 `${ENV_VAR}` |
| WS 无鉴权 | 任意客户端可连接 | 增加简单 token（即使 guest 也验证） |
| SQLite 并发 | WAL 模式但单进程 | 生产环境迁移 PostgreSQL |

---

## 8. 重构检查清单

在开始任何重构前，确认：

- [ ] 当前分支编译通过（`py_compile` + `vue-tsc`）
- [ ] 当前分支可启动（后端 8848 + 前端 1420）
- [ ] `/api/v1/auth/me` 返回 200
- [ ] Agent 列表 API 返回数据
- [ ] 至少完成一轮私聊测试（发送消息 → Agent 回复）
- [ ] 至少完成一轮群聊测试
- [ ] git commit 保存当前状态（方便回滚）

重构后验证：

- [ ] 上述所有检查项仍通过
- [ ] 无新增 `engine/` → `app/` 的 import
- [ ] 被修改文件的行数减少或职责更清晰
- [ ] `grep "ContextManager" backend/ --include="*.py" -r` 无结果（除历史注释外）
