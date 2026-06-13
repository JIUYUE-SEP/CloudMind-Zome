# CloudMind-Zome Provider 子系统重做——完成度检查报告

> **日期**：2026-06-10  
> **范围**：Provider 子系统（4 批重做）现状 + 前端 UI 完整性  
> **状态**：只检查，不改代码，等待指挥官确认后实施

---

## 目录

1. [后端现状检查](#1-后端现状检查)
2. [前端 UI 完整性检查](#2-前端-ui-完整性检查)
3. [差距汇总](#3-差距汇总)
4. [修复建议](#4-修复建议)

---

## 1. 后端现状检查

### 1.1 providers.yaml 状态

**文件路径**：`C:\Users\b1953\.cloudmind-zome\providers.yaml`

**当前内容**：
```yaml
schema_version: 2
last_modified: '2026-06-10T00:00:00'
providers: []
```

**检查结果**：
- ✅ **格式合法**，能被 `Pydantic ProvidersYaml` 正确解析
- **Provider 数量**：**0 个**（空列表）
- 由于 YAML 为空，启动时 `sync_yaml_to_db()` 同步到数据库后，DB 中同样 0 条 Provider

### 1.2 数据库状态

**DB 路径**：`C:\Users\b1953\.cloudmind-zome\cloudmind.db`

| 表 | 总记录数 | 关键字段 |
|----|---------|---------|
| `compute_providers` | **0 条** | — |
| `llm_models` | **0 条** | — |
| `agents` | **1 条** | `provider_id=NULL`, `model_id=NULL` |

**Agent 链路分析**：
- 该 Agent 走 legacy `model_config` JSON 回退
- DB 中无 Provider → `resolve_provider_credentials()` 返回 None
- `_build_transport()` 返回 None → `AgentWorker` 启动失败
- **结论：Agent 对话链路当前完全跑不通**

### 1.3 旧配置残留

| 检查项 | 状态 | 说明 |
|--------|------|------|
| `~/.cloudmind-zome/llmprovider/` | ❌ 不存在 | 已清理 |
| `backend/engine/config.yaml` 中 `provider.*` | ❌ 不存在 | 当前仅含 `tavily`、`agent`、`context`、`tools` |

### 1.4 内置模板生成逻辑

**关键结论**：
- **不会自动生成任何内置 Provider**
- `provider_migration.py` 中**没有任何硬编码 Provider 模板**
- `is_builtin` 字段默认均为 `False`
- 区分方式仅靠 `is_builtin` 布尔字段，但目前 DB 和 YAML 中都没有任何记录
- 首次启动时若 `providers.yaml` 不存在，会尝试从 `config.yaml` 迁移；若两者都不存在，则创建空 YAML

### 1.5 Agent 对话链路

| 场景 | 结果 |
|------|------|
| Agent `provider_id` 非空 + Provider 存在 | 理论可跑通（但当前无 Provider） |
| Agent `provider_id` 非空 + Provider 不存在 | `resolve_provider_credentials()` → None → Worker 启动失败 |
| Agent `provider_id` 为空（当前情况） | 走 `model_config` 回退 → 查 DB 找 active Provider → 无 → 失败 |

---

## 2. 前端 UI 完整性检查

### 2.1 ComputeCenter.vue（算力中枢）

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 添加 Provider 表单 | ⚠️ 部分实现 | 有 `display_name`、`base_url`、`api_key`，均有 placeholder。<br>❌ **缺少 `provider_type` 选择**。<br>❌ 缺少 `auth_mode`、`request_timeout`、`max_retries` 等高级字段。 |
| 编辑 Provider | ✅ 已实现 | 支持改 `display_name`、`base_url`；`api_key` 留空不修改。 |
| 删除 Provider | ✅ 已实现 | 有 `confirm()` 确认弹窗；后端校验 Agent 引用（409）。 |
| 测试连接并发现模型 | ✅ 已实现 | 编辑 Modal 有按钮；调用 `POST /compute/providers/{id}/test`；可勾选一键导入。 |
| 模型管理入口 | ❌ **未实现** | `openModelManager()` 和 Modal 已写好，但**模板中无调用入口**（P0）。 |
| 模型列表表格 | ❌ **未实现** | 编辑 Modal 中为标签云，不是表格（P1）。 |
| 模型编辑 Modal | ❌ **未实现** | `modelManager` Modal 仅只读，无修改/删除控件（P0）。 |
| 模型自动导入 | ✅ 已实现 | 发现 → 勾选 → 一键导入。<br>⚠️ 导入时写死 `context_window: 64000, max_output_tokens: 4096`。 |

### 2.2 ComputeTab.vue（AgentEdit 算力配置 Tab）

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 主模型选择（ModelSelector） | ✅ 已实现 | 级联 Provider → Model，选择后显示窗口大小和最大输出。 |
| temperature 滑块 | ✅ 已实现 | 范围 0-2，step 0.1，hint：「控制输出随机性，0 更确定，2 更有创意」。 |
| top_p 滑块 | ✅ 已实现 | 范围 0-1，step 0.05，hint：「核采样阈值，通常保持 1」。 |
| 独立标注模型（Marker） | ✅ 已实现 | checkbox + ModelSelector + hint。 |
| 独立嵌入模型（Embedder） | ✅ 已实现 | 同上。 |
| 独立压缩模型（Compressor） | ✅ 已实现 | 同上。 |
| Fallback 链 | ✅ 已实现 | 可拖拽排序、可添加/删除、添加时弹出 ModelSelector。 |

### 2.3 ModelSelector.vue（级联选择器组件）

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Provider 下拉框 | ✅ 已实现 | 显示 `display_name`，hint：「选择提供该模型的服务商」。 |
| Model 下拉框 | ✅ 已实现 | 动态加载，显示能力图标（🧠 🔧 👁️）。 |
| 选择后 hint | ✅ 已实现 | 显示 `context_window`、`max_output_tokens`。 |
| 自动选首项 | ✅ 已实现 | 切换 Provider 后自动选中第一个 Model。 |

### 2.4 SystemSettingsPanel.vue

| 检查项 | 状态 | 说明 |
|--------|------|------|
| LLM tab | ✅ 已按设计实现 | 显示迁移提示 + 「前往算力中枢」按钮 + Tavily API Key。 |
| Assistant tab | ✅ 已移除 | 不在 tabs 数组中。 |
| Embedding tab | ✅ 已移除 | 同上。 |
| Tavily API Key | ✅ 保留 | 在 LLM tab 迁移提示下方。 |
| Image tab | ⚠️ 仍存在 | 仍保留在 config.yaml 中，未迁移到 ComputeCenter。 |
| Memory / Tools tab | ✅ 保留 | 正常。 |
| save() 逻辑 | ✅ 已清理 | 不再发送 `provider`、`assistant_model`、`embedding_model`。 |

### 2.5 AgentEdit.vue 整体

| 检查项 | 状态 | 说明 |
|--------|------|------|
| Compute tab 替换为 ComputeTab | ✅ 已实现 | `<ComputeTab>` 组件已接入，v-model 绑定所有新独立字段。 |
| 保存发送新独立字段 | ✅ 已实现 | `PUT /agents/{id}` 发送 `provider_id`、`model_id`、`temperature`、`top_p`、marker/embedder/compressor、fallback_chain。 |
| 回显新字段（优先新字段） | ✅ 已实现 | `data.provider_id || llmCfg.provider_id || firstProv?.id`。 |
| 回退 model_config | ✅ 已实现 | fallback_chain 同时兼容新格式和旧 `llmCfg.fallback_chain`。 |

### 2.6 stores/compute.ts

| 检查项 | 状态 | 说明 |
|--------|------|------|
| ModelInfo 类型定义 | ✅ 已实现 | 完整定义 `id`、`display_name`、`context_window`、`max_output_tokens`、`supports_*`、`status`。 |
| getModelsByProvider() | ✅ 已实现 | — |
| getModelInfo() | ✅ 已实现 | — |
| getProviderById() | ✅ 已实现 | — |
| 30s TTL 缓存 | ✅ 已实现 | `modelCacheTs` 控制。 |
| addModel() / updateModel() / deleteModel() | ✅ 已实现 | 分别调用 `POST /models`、`PUT /models/{pid}/{mid}`、`DELETE /models/{pid}/{mid}`。 |

### 2.7 字段说明覆盖（缺少说明的字段）

#### ComputeCenter.vue
| 字段 | 状态 | 期望说明 |
|------|------|----------|
| `provider_type` | ❌ 无 | 决定该 Provider 使用哪种思考模式解析响应 |
| `auth_mode` | ❌ 无（表单中无此字段） | 认证方式：密钥 / Bearer Token / 无需认证 |
| `request_timeout` | ❌ 无（表单中无此字段） | 等待模型响应的最长时间（秒） |
| `max_retries` | ❌ 无（表单中无此字段） | 网络错误时自动重试次数 |
| `rate_limit_qpm` | ❌ 无（表单中无此字段） | 每分钟最多请求次数，0 表示不限制 |
| `custom_headers` | ❌ 无（表单中无此字段） | 需要额外携带的 HTTP 请求头 |

#### SystemSettingsPanel.vue
| 字段 | 状态 | 备注 |
|------|------|------|
| `memory.compact_threshold` | ❌ 无 | 4 个数字输入框完全没有解释 |
| `memory.keep_recent` | ❌ 无 | 同上 |
| `memory.hot_memory_limit` | ❌ 无 | 同上 |
| `memory.warm_memory_limit` | ❌ 无 | 同上 |
| `image_gen.api_url` / `model` / `api_key` | ❌ 无 | 仅有 placeholder，无 hint |

---

## 3. 差距汇总

### 🔴 P0（必须立即修复，否则功能不可用）

| # | 问题 | 影响 |
|---|------|------|
| 1 | **Provider 卡片缺少「模型管理」入口** | `openModelManager()` 函数和 Modal 已写好但无法触发，模型管理功能完全不可用。后端 API 已就绪，前端只差一个按钮。 |
| 2 | **模型属性不可编辑** | 无修改 `context_window`、`max_output_tokens`、`supports_*` 的 UI。后端 `PUT /models/{pid}/{mid}` 和 `DELETE /models/{pid}/{mid}` 已就绪但前端未对接。 |
| 3 | **系统中没有任何 Provider** | `providers.yaml` 为空，DB 中 0 Provider，Agent 对话链路完全瘫痪。需要手动添加至少一个 Provider，或预置内置模板。 |

### 🟡 P1（强烈建议修复，显著影响体验）

| # | 问题 | 影响 |
|---|------|------|
| 4 | **添加 Provider 表单缺少 `provider_type` 选择** | 后端 `_detect_provider_type()` 根据 base_url 自动推断可能不准确。 |
| 5 | **添加 Provider 表单缺少高级字段** | `auth_mode`、`request_timeout`、`max_retries`、`rate_limit_qpm`、`custom_headers`、`description` 均未暴露。 |
| 6 | **模型自动导入时属性写死** | `context_window: 64000, max_output_tokens: 4096`，无法反映真实模型能力。 |
| 7 | **模型列表不是表格形式** | 当前为标签云，不符合设计文档要求的表格展示。 |
| 8 | **SystemSettingsPanel 多个字段缺少 hint** | Memory 4 个字段 + Image 3 个字段无说明。 |

### 🟢 P2（可以后做）

| # | 问题 | 影响 |
|---|------|------|
| 9 | ImageGen 配置仍在 config.yaml | 设计文档建议迁移到 ComputeCenter，与 Embedding 一致。 |
| 10 | 响应式适配 | 全局无 `@media` 查询，小屏幕体验差。 |

---

## 4. 修复建议

### 阶段一：救命（P0，必须先做）

1. **在 Provider 卡片上添加「模型管理」按钮**
   - 文件：`frontend/src/components/ComputeCenter.vue`
   - 改动：在 `cc-model-list` 或卡片底部增加一个「管理模型」按钮，调用已有的 `openModelManager(p)`
   - 工作量：约 5 行模板代码

2. **将 modelManager Modal 改造为可编辑**
   - 文件：`frontend/src/components/ComputeCenter.vue`
   - 改动：每个模型行增加「编辑」和「删除」按钮；编辑时弹出表单修改 `context_window`、`max_output_tokens`、`supports_reasoning`、`supports_tool_calling`、`supports_multimodal`
   - 对接已有的 `store.updateModel()` 和 `store.deleteModel()`
   - 工作量：约 80 行代码

3. **预置至少一个内置 Provider 或引导用户添加第一个 Provider**
   - 选项 A：在 `provider_migration.py` 中添加默认内置 Provider 模板（DeepSeek / OpenAI 兼容）
   - 选项 B：前端算力中枢空状态时优化引导流程（已有「添加第一个 API 密钥」按钮，但需确保后端能正常创建）

### 阶段二：补齐（P1，建议跟上）

4. **添加 Provider 表单扩展**
   - 增加 `provider_type` 下拉选择（openai / deepseek / ollama / ...）
   - 增加「高级设置」折叠区域，暴露 `auth_mode`、`request_timeout`、`max_retries`、`description`
   - 工作量：约 60 行代码

5. **模型自动导入读取真实属性**
   - 后端 `/providers/{id}/test` 返回模型列表时，若服务商支持（如 OpenAI `/models`），尽量返回模型元数据
   - 前端导入时优先使用返回的属性，默认值作为 fallback
   - 工作量：约 30 行代码

6. **编辑 Modal 模型列表改为表格**
   - 将标签云替换为简单表格，显示名称 + 窗口大小 + 能力图标 + 操作按钮
   - 工作量：约 50 行代码

### 阶段三：打磨（P2，可以排期）

7. **SystemSettingsPanel hint 补充**
8. **ImageGen 配置迁移到 ComputeCenter**（如需要）
9. **全局响应式适配**

---

*报告完成。等待指挥官确认后进入实施阶段。*
