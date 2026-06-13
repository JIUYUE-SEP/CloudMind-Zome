# Model CRUD YAML 同步修复验证报告

> **日期**：2026-06-10  
> **范围**：backend/app/api/models.py YAML 双写同步  
> **状态**：修复完成，验证通过

---

## 问题根因

`backend/app/api/models.py` 的 `create_model`、`update_model`、`delete_model` 操作完成后，**没有回写** `providers.yaml`。导致：

1. DB 中有模型，但 YAML 中 `models: []`
2. 下次启动时 `sync_yaml_to_db()` 以 YAML 为准，将 DB 中的模型视为孤儿并**删除**
3. 用户配置的模型在重启后全部丢失

### 修复内容

| 文件 | 改动 |
|------|------|
| `app/services/provider_migration.py` | 新增 `provider_to_yaml_dict()` 和 `sync_provider_yaml()`（从 compute.py 抽取） |
| `app/api/compute.py` | 删除本地 `_provider_to_yaml_dict` 和 `_sync_provider_yaml`，改为从 `provider_migration.py` import |
| `app/api/models.py` | `create_model` / `update_model` / `delete_model` 的 commit 后，重新加载 Provider（带 `selectinload(models)` + `populate_existing=True`），然后调用 `sync_provider_yaml("upsert", prov)` |

### 关键踩坑

1. **Identity map 缓存**：SQLAlchemy async session 中，commit 后 identity map 仍缓存旧对象。`selectinload` 查询返回的 `scalar_one()` 可能命中缓存，导致 `prov.models` 为空。
   - 解决：`execution_options(populate_existing=True)` 强制用查询结果覆盖 identity map

2. **`expire_all()` 是同步方法**：误写成 `await db.expire_all()` 导致 `TypeError: 'NoneType' object can't be awaited`，FastAPI 返回 500 空响应。
   - 解决：改为 `db.expire_all()`（去掉 await）

---

## 验证结果

### 1. 添加模型 → YAML 同步 ✅

**步骤**：
1. `POST /models` 添加 `deepseek-chat`（context_window=64000）
2. `POST /models` 添加 `deepseek-v4-pro`（context_window=128000）

**结果**：
- API 返回成功
- `providers.yaml` 中对应 Provider 的 `models` 列表包含 2 个模型
- 属性（context_window、max_output_tokens、supports_*）全部正确

### 2. 编辑模型 → YAML 同步 ✅

**步骤**：
1. `PUT /models/{pid}/{mid}` 修改 `deepseek-chat` 的 `context_window` = 32000

**结果**：
- API 返回 `{"updated": true}`
- `providers.yaml` 中 `deepseek-chat` 的 `context_window` 更新为 32000

### 3. 删除模型 → YAML 同步 ✅

**步骤**：
1. `DELETE /models/{pid}/{mid}` 删除 `deepseek-v4-pro`

**结果**：
- API 返回 `{"deleted": true}`
- `providers.yaml` 中 `deepseek-v4-pro` 已移除，仅剩 `deepseek-chat`

### 4. 重启后端 → 模型不丢失 ✅

**步骤**：
1. 删除模型后重启后端
2. 启动日志：`sync_yaml_to_db` 读取 YAML
3. `GET /compute/providers`

**结果**：
- `deepseek-chat` 仍然存在
- `context_window` = 32000（编辑后的值保留）
- **无模型被误删**

### 5. 回归测试 ✅

| 检查项 | 结果 |
|--------|------|
| `python -c "import app.api.models; import app.api.compute; import app.services.provider_migration"` | ✅ 通过 |
| `pytest tests/` | ✅ 134 passed, 1 skipped |
| `vue-tsc --noEmit`（前端） | ✅ 0 错误 |

---

## 修复文件清单

1. `backend/app/services/provider_migration.py` — 新增 `provider_to_yaml_dict()`、`sync_provider_yaml()`
2. `backend/app/api/compute.py` — 移除本地 YAML sync 函数，改为 import
3. `backend/app/api/models.py` — create/update/delete 后调用 `sync_provider_yaml()`

---

*报告完成。*
