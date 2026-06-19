# Agent Global Worker Architecture

> **状态：已落地**（2026-06-19 注）
> 本文档为 Worker 重构初期的设计稿。最终实现中 Context Pipeline 采用 **L1-L6 六层**（非 L0-L7），降级顺序 **L5→L4→L3**（非 L6→L5→L4）。Agent 状态机仅有 `idle → busy → idle`（无 `introspecting` 状态）。以下内容为历史规划，仅供参考。

## 1. Core Principle

Each Agent is an independent digital life. One soul, one thread, one memory, one FIFO queue for all tasks.

```
Not: "create a ReActAgent instance per request"
But:  "one ReActAgent instance per Agent, handling all requests serially"
```

## 2. Global Worker Model

```
Agent Alpha Worker (asyncio.Task)
  |
  +-- asyncio.Queue (FIFO)
  |     Job-1 [private] -> Job-2 [group@] -> Job-3 [workflow] -> ...
  |
  +-- ReActAgent (single instance)
  |     + personality_prompt (system, reused every round)
  |     + scene-isolated message history (by source_id)
  |     + L0-L3 system prompt injected by MessageBuilder per round
  |     + SmartStop (global, cross-scene)
  |
  +-- Unified Memory Pool (SQLite: agent_messages)
        agent_id | role | content | source | source_name | timestamp
```

## 3. Job Data Structure

```python
@dataclass
class AgentJob:
    job_id: str           # UUID for tracing
    source: str           # "private" | "group" | "workflow"
    source_id: str        # session_id | group_session_id | action_run_id
    source_name: str      # "与调度员的私聊" | "技术交流群" | "每日代码审查"
    sender_id: str        # user_id / agent_id / "workflow_system"
    sender_name: str      # "调度员" / "Beta" / "工作流引擎"
    content: str          # message content / workflow instruction
    # Callbacks
    on_chunk: Callable[[str], Awaitable[None]]     # streaming chunk
    on_done:  Callable[[str, bool], Awaitable[None]] # final text + success
```

## 4. System Prompt Scene Injection

Every LLM round appends scene info after the personality prompt:

```
你的名字是 {name}。
这是你曾经的过往，你作为心智回到了这个世界。

{personality_prompt}

────────────────
当前场景：{source_name}
────────────────
```

Examples:
- Private: `当前场景：与调度员的私聊`
- Group:   `当前场景：群聊"技术交流群" \n提及你的成员：调度员`
- Workflow: `当前场景：工作流"每日代码审查"（节点：生成测试用例）`

## 5. State Machine (Reliable in Single Thread)

```
idle --[receive Job]--> busy --[done]--> idle
                          ^      |
                          +--[new Job in queue]--+
                          (process next without going idle)
```

`Agent.status` in DB is maintained by the Worker itself. Because it is single-threaded, it is absolutely reliable.

## 6. Dispatch Entry Changes

| Entry      | Current                         | New                                   |
|------------|----------------------------------|---------------------------------------|
| WS Private | `_stream_single_agent()`        | Put Job in Agent Worker queue         |
| WS Group   | `_stream_single_agent()` x N    | Put Job in each target Agent queue    |
| Workflow   | `bridge.stream_chat()`          | Put Job in Agent Worker, block wait   |

**No entry creates a ReActAgent instance directly.**

## 7. Private Chat Interrupt

Only private chat supports user-initiated stop:

- User clicks pause button -> sends `agent.stop` WS frame
- Worker checks stop signal **only when source == "private"**
- Group chat and workflow ignore stop signals
- Stop signal is per-Job, not global

## 8. File Change List

| File | Action | Description |
|------|--------|-------------|
| `app/services/agent_worker.py` | New | AgentWorker class, global Task + Queue |
| `app/services/job_queue.py` | New | Job dataclass and queue registry |
| `app/services/engine_bridge.py` | Rewrite | Dispatch Job instead of creating ReActAgent |
| `app/api/ws.py` | Update | Private/group chat call new EngineBridge |
| `app/services/workflow_engine.py` | Update | Node execution: put Job + block wait |
| `app/services/group_chat_router.py` | Update | Remove `status == idle` filter |
| `engine/agent/react.py` | Update | `_build_system_prompt(scene_info)` |
| `engine/session/store.py` | Update | Store by agent_id with source tag |
| `engine/context/manager.py` | Delete | 已被 ContextPipeline 完全替代 |

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Workflow node blocks waiting for Agent busy in chat | Same FIFO queue, strict fairness. V1.2: add priority |
| Unified memory too large, token overflow | ContextPipeline downgrade (L6→L5→L4) + TopicCompressionMemory. V1.2: add summarization |
| Group reply delayed (waiting for private chat) | By design. User sees "Alpha is thinking" |
| Worker Task crashes | `try/except` around Job execution; single Job failure does not kill Worker |
