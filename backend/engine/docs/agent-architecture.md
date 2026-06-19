# CloudMind-Zome Agent Architecture

## Project Structure

```
backend/
  app/
    api/          # REST + WebSocket API
      ws.py           # WebSocket routing (thin layer)
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
      commission_scheduler.py
      workflow_engine.py
  engine/         # Agent engine
    agent/
      react.py           # ReActAgent core loop
      message_builder.py # System prompt builder (tag + scene)
      stop.py            # SmartStop
      base.py            # AgentBase abstract class
    context/
      context_pipeline.py  # Context assembly (L1-L6 + downgrade)
      embedder.py          # Embedding client (OpenAI-compatible)
      vector_store.py      # zvec semantic memory store
    memory/
      base.py              # MemorySystem ABC
      registry.py          # Memory system factory
      simple/              # SimpleMemory (no compression)
      topic_compression/   # TopicCompressionMemory
        topic_memory.py    # Full implementation
        topic_context.py   # Topic tree data model
        marker.py          # Topic detection (LLM-based)
        trigger.py         # Compression trigger logic
        worker.py          # Async CompressionWorker
        estimator.py       # Token estimation
        pruner.py          # Tool result pruning
    message/types.py     # Message, ContentBlock, AgentEvent types
    provider/
      transport.py       # OpenAI-compatible transport
      factory.py         # Transport builder
      thinking/          # Provider-specific thinking profiles
    session/store.py     # SQLite session store
    config/              # Configuration (Pydantic models + YAML loader)
    error/               # Error classification, retry, fallback
    tool/
      registry.py        # Tool registry + auto-discovery
    tools/               # Tool implementations
      code/    # python_execute
      file/    # read_file, write_file, edit_file, delete_file, share_file
      shell/   # shell_command
      web/     # search_web, generate_image
      comms/   # send_private_message, report_workflow_progress
      project/ # project_knowledge
frontend/       # Vue 3 + Vite + TypeScript + Pinia
  src/components/
    ChatView.vue
    GroupChatView.vue
    CommunicationHub.vue
    AgentEdit.vue
    ActionCenter.vue
    CommissionCenter.vue
    ComputeCenter.vue
    SystemSettingsPanel.vue
```

## Core Concepts

### Agent = Single Digital Life
- One `AgentWorker` per `agent_id`
- One `ReActAgent` instance per Worker (never recreated)
- Scene-isolated memory: `_messages` cleared when `source_id` changes
- FIFO queue for all jobs (private/group/workflow/commission)

### Job Sources
| Source | Trigger | Queue Behavior |
|--------|---------|---------------|
| private | User sends message | Normal FIFO |
| group | @mention or intent routing | Normal FIFO |
| workflow | Action node execution | Normal FIFO |
| commission | Scheduled task | Normal FIFO |
| proactive_wake | Intimacy trigger | Normal FIFO (future) |

### Status Lifecycle
```
idle -> busy (Job starts) -> idle (Job done/failed/stopped)
```

### Context Pipeline (L1-L6)
Each LLM round assembles context in priority order:

| Layer | Source | Downgrade |
|-------|--------|-----------|
| L1 | Mind files (SOUL.md / AGENT.md / USER.md) | Never |
| L2 | Scene info (source_name + sender_name) | Never |
| L3 | Hot Context (_messages, scene-isolated) | 20->15->10->5 |
| L4 | Semantic retrieval (zvec cross-scene) | 10->5->3->0 |
| L5 | Topic summaries (_compressed/*.md) | Merge -> Drop |
| L6 | Tool descriptions | Never |

Downgrade order: **L5 -> L4 -> L3**

### Memory System Plugins
The memory system is pluggable via `MemorySystem` ABC:

| Implementation | Features | Config |
|----------------|----------|--------|
| `SimpleMemory` | No compression, keeps all messages | `memory_system: simple` |
| `TopicCompressionMemory` | Topic detection, async compression, zvec indexing | `memory_system: topic_compression` |

**TopicCompressionMemory flow:**
1. `TopicMarker` analyzes recent messages -> detects topic label
2. Label change confirmed -> `TopicContext` switches topic
3. Topic closed -> `CompressionWorker` generates summary
4. Summary saved to `_compressed/{topic}.md`
5. Summary indexed to zvec `agent_topics`
6. Original messages deleted from `agent_messages`

### Semantic Memory (zvec)
- **Collection**: `agent_memory` — all agents' messages, filtered by `agent_id`
- **Schema**: `message_id`, `agent_id`, `text`, `role`, `source`, `source_id`, `source_name`, `timestamp`, `embedding`
- **Search**: HNSW approximate nearest neighbor, cross-scene, with time-decay scoring
- **Topics collection**: `agent_topics` — compressed topic summaries for warm memory

### Key Files for Modifications
- Add tool: `engine/tools/{toolset}/new_tool.py`
- Register tool: Auto-discovered by `tool_registry.discover()`
- Add API: `app/api/{module}.py`
- Add model: `app/models/{name}.py`
- Worker logic: `app/services/agent_worker.py`
- Agent loop: `engine/agent/react.py`
- Context assembly: `engine/context/context_pipeline.py`
- Memory system: `engine/memory/topic_compression/topic_memory.py`
