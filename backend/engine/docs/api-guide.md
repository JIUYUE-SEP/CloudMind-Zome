# Backend API Guide for CloudMind-Zome

## Authentication

No login required. All users operate as guest.
`require_user()` returns guest user directly.

## REST API Structure

All routes under `/api/v1/`

### Agents
| Method | Path | Description |
|--------|------|-------------|
| GET | /agents | List agents |
| POST | /agents | Create agent |
| GET | /agents/{id} | Get agent detail |
| PUT | /agents/{id} | Update agent |
| DELETE | /agents/{id} | Delete agent (soft) |
| POST | /agents/{id}/portrait | Upload portrait |
| POST | /agents/{id}/model | Upload 3D model |
| POST | /agents/{id}/live2d | Upload Live2D |
| GET | /agents/{id}/memory | Get memory stats |

### Chat Sessions
| Method | Path | Description |
|--------|------|-------------|
| POST | /chats/sessions/private | Create/find private session |
| GET | /chats/sessions | List sessions |
| GET | /chats/sessions/{id}/messages | Get messages |
| POST | /chats/sessions/{id}/messages | Send message (HTTP) |
| PUT | /chats/sessions/{id}/pin | Pin/unpin session |
| PUT | /chats/sessions/{id}/read | Mark as read |

### Groups
| Method | Path | Description |
|--------|------|-------------|
| POST | /chats/groups | Create group |
| GET | /chats/groups/{id} | Get group detail |
| PUT | /chats/groups/{id} | Update group settings |
| DELETE | /chats/groups/{id} | Dissolve group |
| POST | /chats/groups/{id}/members | Invite members |
| DELETE | /chats/groups/{id}/members/{mid} | Remove member |
| PUT | /chats/groups/{id}/conductor | Appoint conductor |

### Compute Providers
| Method | Path | Description |
|--------|------|-------------|
| GET | /compute/providers | List providers |
| POST | /compute/providers | Create provider |
| PUT | /compute/providers/{id} | Update provider |
| DELETE | /compute/providers/{id} | Delete provider |
| POST | /compute/providers/{id}/test | Test connection |
| GET | /compute/usage | Get usage stats |

### Actions/Workflows
| Method | Path | Description |
|--------|------|-------------|
| GET | /actions | List blueprints |
| POST | /actions | Create blueprint |
| GET | /actions/{id} | Get blueprint |
| PUT | /actions/{id} | Update blueprint |
| POST | /actions/{id}/run | Run blueprint |
| POST | /actions/from-task | Save from task |

### Commissions
| Method | Path | Description |
|--------|------|-------------|
| GET | /commissions | List commissions |
| POST | /commissions | Create commission |
| PUT | /commissions/{id} | Update commission |
| DELETE | /commissions/{id} | Delete commission |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | /config | Get engine config |
| PUT | /config | Update config |
| POST | /upload | File upload |
| GET | /auth/me | Get current user |
| PUT | /auth/me | Update user profile |
| GET | /system/health | Health check |

## WebSocket API

Endpoint: `ws://host/api/v1/ws`

### Client -> Server Messages
| Type | Payload | Description |
|------|---------|-------------|
| chat.send | {session_id, content, content_type, reply_to, client_msg_id} | Send message |
| chat.typing | {session_id, is_typing} | Typing indicator |
| agent.stop | {session_id, agent_id} | Stop agent (private only) |
| ping | {} | Heartbeat |

### Server -> Client Messages
| Type | Payload | Description |
|------|---------|-------------|
| auth.success | {user_id} | Connection established |
| chat.message | {session_id, message} | New message |
| chat.ack | {session_id, client_msg_id, status} | Message ack |
| chat.typing | {session_id, user_id, is_typing} | Typing status |
| chat.thinking | {session_id, agent_id, thinking, batch_id} | Agent thinking |
| chat.tool_call | {session_id, agent_id, tool_name, tool_input} | Tool call |
| agent.status | {agent_id, status} | Status change |
| action.progress | {run_id, node_id, node_status, overall_progress} | Workflow progress |
| intermind.start | {session_id} | Intermind begins |
| intermind.end | {session_id} | Intermind ends |
| notification.new | {title, content} | System notification |

## Key Data Models

### Agent (agents table)
- id, name, codename, personality_prompt
- model_config: {provider_id, model, provider, temperature, max_tokens}
- tags: list[str] — grouping labels
- aliases: list[str] — alternative names for @mention
- capabilities: list[str] — capability tags for intent routing
- status: idle / busy / introspecting
- role: member / conductor
- daily_token_limit, daily_tokens_used

### ChatSession
- id, type (private/group), name, settings
- conductor_agent_id — group conductor
- members: ChatSessionMember[]
- status: active / dissolved

### ChatMessage
- id, session_id, sender_id, sender_type
- content, content_type (text/image/mixed/system)
- reply_to, batch_id, client_msg_id
- is_deleted

## Important Backend Files
| Purpose | Path |
|---------|------|
| Main app | `backend/app/main.py` |
| Agent Worker | `backend/app/services/agent_worker.py` |
| Engine Bridge | `backend/app/services/engine_bridge.py` |
| ReActAgent | `backend/engine/agent/react.py` |
| Context Pipeline | `backend/engine/context/context_pipeline.py` |
| Transport | `backend/engine/provider/transport.py` |
| Tool Registry | `backend/engine/tool/registry.py` |
| Session Store | `backend/engine/session/store.py` |
| Vector Store | `backend/engine/context/vector_store.py` |
