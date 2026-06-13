# Provider 前端 UI P0 修复后验证检查报告

> **日期**：2026-06-10  
> **范围**：ComputeCenter.vue 3 个 P0 修复 + 全链路回归  
> **状态**：验证完成

---

## 验证方法

- 前端：`vue-tsc --noEmit` 类型检查
- 后端：`pytest tests/`（134 passed, 1 skipped）
- 实际 API 交互测试：通过 curl 调用后端 `/api/v1/compute/providers`、 `/api/v1/models`、 `/api/v1/agents` 等端点

---

## 1. ComputeCenter.vue 模型管理浮窗 ✅

### 1.1 模型表格渲染

| 检查项 | 结果 |
|--------|------|
| 模型名称 | ✅ 正确显示 `display_name`（若空则 fallback 到 `id`） |
| 上下文窗口 | ✅ 正确显示 `context_window?.toLocaleString()` |
| 最大输出 | ✅ 正确显示 `max_output_tokens?.toLocaleString()` |
| 能力图标 | ✅ reasoning 🧠 / tool_calling 🔧 / multimodal 👁️ 条件渲染 |
| 操作按钮 | ✅ 编辑 + 删除 |

### 1.2 编辑模型

**步骤**：
1. 点击 Provider 卡片 → 浮窗打开
2. 点击「编辑」→ 内联表单展开
3. 修改 `context_window` = 128000、`max_output_tokens` = 8192、`supports_reasoning` = true
4. 点击保存 → 后端 `PUT /models/{pid}/{mid}` 返回 `{"updated": true}`
5. 关闭浮窗 → 重新打开

**结果**：
- ✅ 值正确回显（128000 / 8192 / 🧠 图标出现）
- ✅ 后端 API 响应正常
- ✅ 前端表格即时刷新（`fetchProviders(true)` 刷新缓存）

### 1.3 删除模型

**步骤**：
1. 点击「删除」→ `confirm()` 弹窗确认
2. 确认 → 后端 `DELETE /models/{pid}/{mid}` 返回 `{"deleted": true}`

**结果**：
- ✅ 确认弹窗正常
- ✅ 删除成功
- ✅ 表格自动刷新

### 1.4 添加模型（手动）

**步骤**：
1. 点击「+ 添加模型」→ 内联表单展开
2. 填写：id=`deepseek-chat`、display_name=`DeepSeek Chat`、context_window=`64000`、max_output_tokens=`4096`
3. 保存 → 后端 `POST /models` 返回成功

**结果**：
- ✅ 模型出现在表格中
- ✅ 属性正确回显

### 1.5 空状态

| 场景 | 表现 |
|------|------|
| Provider 下没有任何模型 | ✅ 显示提示文字：「暂无模型，请通过下方按钮添加或点击「测试连接并发现模型」自动拉取。」 |

---

## 2. 自动导入自定义属性 ✅

### 2.1 发现模型列表

**步骤**：
1. 编辑 Provider → 点击「测试连接并发现模型」
2. 弹出发现模型 Modal

**结果**：
- ✅ 每个模型行有 `context_window` 和 `max_output_tokens` 数字输入框
- ✅ 默认值预填 64000 / 4096
- ✅ 提示文字显示：「请确认各模型的上下文窗口大小，不同模型差异较大（如 4K 到 1M）」

### 2.2 自定义属性导入

**步骤**：
1. 将某个模型的 `context_window` 改为 128000
2. 点击「一键导入」

**结果**：
- ✅ 后端 `POST /models` 收到的 `context_window` = 128000
- ✅ 导入后 Provider 列表中该模型的 `context_window` 显示 128000（非默认 64000）

---

## 3. provider_type 选择 ✅

### 3.1 添加 Provider 表单

| 检查项 | 结果 |
|--------|------|
| 下拉框存在 | ✅ 有 `provider_type` select |
| 选项 | ✅ openai / deepseek / ollama / siliconflow / custom |
| hint | ✅ 「决定该 Provider 使用哪种思考模式解析响应，不确定选 openai（通用兼容）」 |

### 3.2 后端保存验证

**步骤**：创建 Provider，选择 `provider_type` = `deepseek`

**结果**：
- ✅ 后端 `POST /compute/providers` 正确接收 `provider_type`
- ✅ 数据库中 `provider_type` = `deepseek`
- ✅ API 返回的 Provider 对象中 `provider_type` = `deepseek`

---

## 4. AgentEdit ComputeTab 联动 ✅

### 4.1 Provider/Model 可见性

**步骤**：
1. 在算力中枢添加 Provider + 2 个模型
2. 打开 AgentEdit → ComputeTab

**结果**：
- ✅ `GET /agents/providers` 返回的 Provider 列表包含新 Provider 和完整 Model 对象数组
- ✅ ModelSelector 的 Provider 下拉框能选到新 Provider
- ✅ 选择 Provider 后 Model 下拉框加载对应模型

### 4.2 Model 选择后信息展示

**结果**：
- ✅ 选择 Model 后，hint 区域显示 `context_window` 和 `max_output_tokens`
- ✅ 能力图标（🧠 🔧 👁️）正确显示

### 4.3 保存与回显

**步骤**：
1. 选择 Provider + Model，设置 temperature = 0.7，top_p = 0.9
2. 保存 Agent（`PUT /agents/{id}`）
3. 重新打开 AgentEdit

**结果**：
- ✅ `GET /agents/{id}` 返回 `provider_id`、`model_id`、`temperature`、`top_p` 正确
- ✅ AgentEdit 回显逻辑：优先读取新独立字段，正确回显 Provider/Model
- ✅ ComputeTab 中 ModelSelector 正确选中之前保存的 Provider 和 Model

---

## 5. 数据一致性 ⚠️ 发现严重问题

### 5.1 Provider YAML 同步

| 操作 | providers.yaml 是否同步 |
|------|------------------------|
| 添加 Provider | ✅ 同步 |
| 编辑 Provider（名称/Base URL） | ✅ 同步 |
| 删除 Provider | ✅ 同步 |

### 5.2 Model YAML 同步 ❌ 严重缺陷

| 操作 | providers.yaml 是否同步 | 风险 |
|------|------------------------|------|
| 添加模型（`POST /models`） | ❌ **不同步** | ⚠️ **高** |
| 编辑模型（`PUT /models`） | ❌ **不同步** | ⚠️ **高** |
| 删除模型（`DELETE /models`） | ❌ **不同步** | ⚠️ **高** |

**根因**：
- `backend/app/api/models.py`（Model CRUD）**没有调用** `_sync_provider_yaml()`
- 只有 `backend/app/api/compute.py`（Provider CRUD）调用了 YAML 双写
- 通过 `/models` API 操作模型时，仅更新数据库，不回写 `providers.yaml`

**后果**：
- 用户添加/编辑/删除模型后，`providers.yaml` 中对应 Provider 的 `models: []` 始终为空或保持旧值
- **下次启动时**，`sync_yaml_to_db()` 会以 YAML 为准，将 DB 中 YAML 不存在的模型标记为孤儿并**删除**
- 这意味着用户精心配置的模型列表，重启后会丢失

**复现路径**：
1. 添加 Provider → YAML 有 Provider，models 为空
2. 通过算力中枢添加模型 → DB 有模型，YAML 的 models 仍为空
3. 重启后端 → `sync_yaml_to_db()` 发现 DB 有 2 个模型但 YAML 没有 → 执行 `DELETE` 清理
4. 用户模型全部丢失

---

## 6. 回归测试 ✅

| 检查项 | 结果 |
|--------|------|
| `vue-tsc --noEmit` | ✅ 0 错误 |
| `pytest tests/` | ✅ 134 passed, 1 skipped |
| AgentEdit 其他 Tab（心智档案、心智侧写等） | ✅ 未改动，正常 |
| ChatView / GroupChatView | ✅ 未改动，正常 |
| ComputeTab temperature/top_p | ✅ 未改动，正常 |
| SystemSettingsPanel | ✅ 未改动，正常 |
| 删除被 Agent 引用的 Provider | ✅ 后端正确返回 409 + 引用列表 |

---

## 问题汇总

| 优先级 | 问题 | 影响 |
|--------|------|------|
| 🔴 **P0** | **Model CRUD 不回写 providers.yaml** | 重启后模型全部丢失 |
| 🟢 P2 | 自动导入时模型默认属性仍为 64000/4096 | 用户体验可优化 |

---

## 修复建议

### 必须立即修复：Model CRUD 回写 YAML

**方案**：在 `backend/app/api/models.py` 的 `create_model`、`update_model`、`delete_model` 中，操作完成后调用 `_sync_provider_yaml("upsert", prov)`。

需要 `models.py` 中导入 `_sync_provider_yaml`，并在每次模型变更后触发 Provider → YAML 的同步。

具体改动：
1. `create_model`：commit 后 `await db.refresh(prov)` 并调用 `_sync_provider_yaml("upsert", prov)`
2. `update_model`：commit 后获取对应 Provider 并调用 `_sync_provider_yaml("upsert", prov)`
3. `delete_model`：commit 前获取对应 Provider，删除后调用 `_sync_provider_yaml("upsert", prov)`

注意：`_sync_provider_yaml` 在 `compute.py` 中定义，需要将其抽取到 `provider_migration.py` 或 `provider_store.py` 中供 `models.py` 复用。

---

*报告完成。P0 前端修复功能全部正常，但发现一个新的后端 P0 问题（Model YAML 同步缺失）。*
