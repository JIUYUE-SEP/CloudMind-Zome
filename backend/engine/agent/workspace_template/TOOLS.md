# TOOLS.md - 环境专属备忘

Skill 定义工具的**用法**，这个文件记录你的**环境细节**。

## 可以放什么

- 项目路径
- Python / Node 解释器位置
- Git 分支约定
- 常用命令别名
- 上传/下载目录
- API 地址

## 示例

```markdown
### 项目路径

- 后端：`<填入你的后端目录绝对路径>`
- 前端：`<填入你的前端目录绝对路径>`

### Python

- 解释器：`python` 或具体路径
- 启动后端：`cd backend && python run.py`

### Git

- 当前分支：`<填入你的工作分支>`
- 主分支：`main`
- commit message 前缀：`feat:` / `fix:` / `perf:` / `docs:`

### API

- 后端 base URL：`http://127.0.0.1:8848`
- WebSocket：`ws://127.0.0.1:8848/api/v1/ws`

### 上传目录

- 本地：`{DATA_DIR}\uploads`
- URL 前缀：`/uploads/`
```

## 为什么分开？

Skill 是通用的，你的环境是私有的。把它们分开，意味着你可以更新 skill 而不丢失自己的笔记，也可以分享 skill 而不泄露你的基础设施。

---

把你觉得有用的东西加进来。这是你的速查表。
