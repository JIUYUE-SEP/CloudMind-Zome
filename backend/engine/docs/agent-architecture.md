# CloudMind-Zome Agent Architecture

## Project Structure

```
backend/
  app/
    api/          # REST + WebSocket API
      ws.py           # WebSocket routing
      ws_handlers.py  # Chat, agent, typing handlers
      ws_protocol.py  # Frame building, stop signals
      actions.py        # Workflow/action REST
      agents.py         # Agent CRUD
      chat.py           # Chat session REST
      compute.py        # Provider CRUD
      groups.py         # Group chat REST
    models/       # SQLAlchemy models (17 tables)
    services/     # Business logic
      agent_worker.py    # Agent Worker (FIFO queue, single ReActAgent)
      engine_bridge.py   # Platform -> AgentWorker bridge
      job_queue.py       # AgentJob queue
      conductor_service.py
      group_chat_router.py
      group_task_engine.py
  engine/         # Agent engine (copied from ANewAgentToolScheduling)
    agent/
      react.py           # ReActAgent core loop
      message_builder.py # System prompt builder
      stop.py            # SmartStop
    context/
      manager.py         # Memory layers (semantic/hot/warm/cold)
      embedder.py        # Embedding client
      vector_store.py    # ChromaDB store
    message/types.py     # Message, ContentBlock types
    provider/
      transport.py       # OpenAI-compatible transport
      factory.py         # Transport builder
    session/store.py     # SQLite session store
    tool/
      registry.py        # Tool registry + auto-discovery
    tools/               # Tool implementations
      code/    # python_execute
      file/    # read_file, write_file, edit_file, delete_file, share_file
      shell/   # shell_command
      web/     # search_web, generate_image
      comms/   # send_private_message, report_workflow_progress
frontend/       # Vue 3 + Vite
  src/components/
    ChatView.vue
    GroupChatView.vue
    AgentEdit.vue
    ComputeCenter.vue
```

## Core Concepts

### Agent = Single Digital Life
- One AgentWorker per agent_id
- One ReActAgent instance per Worker
- One unified memory pool (agent_messages table)
- FIFO queue for all jobs (private/group/workflow/commission)

### Job Sources
| Source | Trigger | Queue Behavior |
|--------|---------|---------------|
| private | User sends message | Normal FIFO |
| group | @mention or intent routing | Normal FIFO |
| workflow | Action node execution | Normal FIFO |
| commission | Scheduled task | Normal FIFO |
| proactive_wake | Intimacy trigger | Normal FIFO |

### Status Lifecycle
```
idle -> busy (Job starts) -> idle (Job done/failed/stopped)
idle -> introspecting (idle >5min + messages>10) -> idle
```

### Memory Layers
1. **in-memory** (_messages): Hot, full history
2. **SQLite** (agent_messages): Persistent, source-tagged
3. **ChromaDB** (vectors/): Semantic search
4. **warm/cold**: Compressed summaries

### Key Files for Modifications
- Add tool: `engine/tools/{toolset}/new_tool.py`
- Register tool: Auto-discovered by `tool_registry.discover()`
- Add API: `app/api/{module}.py`
- Add model: `app/models/{name}.py`
- Worker logic: `app/services/agent_worker.py`
- Agent loop: `engine/agent/react.py`
