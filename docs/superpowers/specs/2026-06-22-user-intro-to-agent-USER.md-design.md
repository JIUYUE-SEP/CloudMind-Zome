# 用户自我介绍同步到 Agent USER.md 设计文档

## 日期：2026-06-22
## 方案：A（简单复制）

---

## 背景

当前系统中：
- `userdata/profile.md`：全局用户档案，所有 Agent 共享，自由格式 markdown
- `workspace/{agent_id}/USER.md`：每个 Agent 独立，初始为空模板，需 Agent 在对话中自行了解用户后填写

用户希望：在前端设置结构化自我介绍，创建 Agent 时自动复制到该 Agent 的 `USER.md` 作为初始内容，之后由 Agent 自行维护。

---

## 目标

1. 用户可在前端编辑结构化自我介绍
2. 创建新 Agent 时，自动将用户自我介绍复制到 `workspace/{agent_id}/USER.md`
3. 之后 Agent 自行编辑 `USER.md`，用户不再干预（除非重新创建 Agent）

---

## 数据流

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────────┐
│  前端自我介绍    │────►│  userdata/user_intro │────►│  workspace/{id}/USER.md  │
│  编辑页面        │     │  .md                 │     │  (Agent 初始内容)        │
└─────────────────┘     └──────────────────────┘     └─────────────────────────┘
                                                               │
                                                               ▼
                                                    ┌─────────────────────────┐
                                                    │  Agent 自行编辑更新      │
                                                    │  (对话中积累认知)        │
                                                    └─────────────────────────┘
```

---

## 字段设计

用户自我介绍包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 用户名字 |
| `preferred_name` | string | 希望 Agent 如何称呼自己 |
| `timezone` | string | 时区，如 `Asia/Shanghai` |
| `notes` | string | 偏好、习惯、禁忌等备注 |

存储为 markdown 格式：

```markdown
# 关于我

- **名字：** 张三
- **称呼方式：** 老板
- **时区：** Asia/Shanghai
- **备注：** 喜欢简洁回答，讨厌 emoji
```

---

## API 设计

### 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/user/intro` | 读取用户自我介绍 |
| `PUT` | `/user/intro` | 保存用户自我介绍 |

### 请求/响应格式

**GET /user/intro**
```json
{
  "code": 0,
  "data": {
    "content": "# 关于我\n\n- **名字：** 张三\n..."
  }
}
```

**PUT /user/intro**
```json
// Request
{
  "content": "# 关于我\n\n- **名字：** 张三\n..."
}

// Response
{
  "code": 0,
  "data": {
    "content": "# 关于我\n\n- **名字：** 张三\n..."
  }
}
```

---

## 修改点

### 后端

1. **`backend/app/api/user.py`**
   - 新增 `GET /user/intro` 和 `PUT /user/intro`
   - 文件路径：`DATA_DIR / "userdata" / "user_intro.md"`

2. **`backend/app/api/agents.py`**
   - 创建 Agent 时（`POST /agents`），在 `ensure_agent_workspace()` 之后：
     - 读取 `userdata/user_intro.md`
     - 如果存在，写入 `workspace/{agent_id}/USER.md`
   - 如果 `user_intro.md` 不存在，保留模板默认内容

3. **`backend/engine/agent/workspace_template/USER.md`**
   - 更新模板，与 `user_intro.md` 格式一致，但带注释引导：
     ```markdown
     # USER.md - 关于你正在帮助的人

     <!-- 以下内容来自用户的自我介绍，你可以在此基础上补充你对用户的了解 -->

     - **名字：** <待填写>
     - **称呼方式：** <待填写>
     - **时区：** <待填写>
     - **备注：** <待填写>
     ```

### 前端

1. **新增/修改自我介绍编辑页面**
   - 可以复用 `UserProfileModal.vue` 或新增独立页面
   - 提供结构化表单（名字、称呼方式、时区、备注）
   - 生成 markdown 保存到后端
   - 也可以保留原始 markdown 编辑模式作为高级选项

2. **时区选择器**
   - 提供常用时区下拉列表（如 IANA 时区数据库）

---

## 边界情况

| 场景 | 处理 |
|------|------|
| 用户未设置自我介绍 | 创建 Agent 时保留模板默认内容 |
| 用户自我介绍为空 | 同上 |
| 用户修改自我介绍后 | 只影响新创建的 Agent，已有 Agent 不受影响 |
| Agent 已存在 `USER.md` | 不覆盖，保持 Agent 自己积累的内容 |

---

## 未来扩展（可选）

- **方案 B 迁移**：如果需要用户修改后同步所有 Agent，可以后续实现分段更新（基础信息 vs Agent 认知）
- **多用户支持**：当前设计为单用户应用，多用户时需将 `user_intro.md` 与用户 ID 关联

---

## 验收标准

- [ ] 用户可在前端编辑自我介绍（名字、称呼方式、时区、备注）
- [ ] 自我介绍保存到 `userdata/user_intro.md`
- [ ] 创建新 Agent 时，`USER.md` 初始内容为用户自我介绍
- [ ] 如果用户未设置自我介绍，`USER.md` 使用模板默认内容
- [ ] Agent 创建后，自行编辑 `USER.md` 不会丢失用户自我介绍的基础信息
