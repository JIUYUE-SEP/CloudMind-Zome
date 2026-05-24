# Chat Experience Refactor Plan

## Goal

Align CloudMind-Zome's chat interaction with pi/ChatGPT-level UX:
- Unified message bubble (reasoning + tools + content inside one bubble)
- Smart auto-scroll (user-scroll-aware, interruptible)
- Typing stream effect (content appears character-by-character)

---

## Current Problems

### 1. Message Fragmentation

**Current:**
```
User: 你好
Agent: [thinking block 1]       -- standalone gray bubble
Agent: [tool_call search_web]    -- standalone gray bubble
Agent: [thinking block 2]       -- standalone gray bubble
Agent: 你好呀！                 -- formal reply bubble
```

**Expected (pi-style):**
```
User: 你好
Agent: [reasoning bar] | [tool bar] | 你好呀！
        -- all inside ONE bubble
```

**Root cause:** `thinking` and `tool_call` are stored as independent messages with `content_type: 'thinking' | 'tool_call'`. They render as separate DOM nodes.

### 2. Forced Scroll on Thinking/Tool

**Current behavior:**
- `onThinking()` directly sets `scrollTop = scrollHeight`
- `onToolCall()` directly sets `scrollTop = scrollHeight`
- This bypasses the `isAtBottom` check entirely

**Result:** Even when user is reading history, Agent thinking pulls them down forcefully.

### 3. No "New Messages" Toast

When user scrolls up to read history:
- pi shows a floating `\u2193 \u65b0\u6d88\u606f` button
- We show nothing -- user doesn't know new content arrived

### 4. No Typing Stream Effect

Agent content appears all at once after full generation. pi/ChatGPT show text appearing progressively.

---

## Refactor Plan

### Phase 1: Scroll Architecture (Foundation)

**New state model:**
```typescript
const autoScroll = ref(true)           // master switch, NOT distance-based
const isProgrammaticScroll = ref(false) // guard to distinguish source
const showNewMessageTip = ref(false)    // floating toast visibility
```

**New event handler:**
```typescript
function onScroll() {
  if (isProgrammaticScroll.value) return  // ignore programmatic scrolls
  autoScroll.value = false
  showNewMessageTip.value = true
}
```

**New scroll function:**
```typescript
function scrollToBottom() {
  isProgrammaticScroll.value = true
  msgArea.value.scrollTop = msgArea.value.scrollHeight
  nextTick(() => { isProgrammaticScroll.value = false })
}

function onNewContent() {
  if (autoScroll.value) {
    scrollToBottom()
  } else {
    showNewMessageTip.value = true
  }
}
```

**Auto-recovery:** When user manually scrolls back to bottom (< 50px from end):
```typescript
function checkAutoScrollRecovery() {
  if (!msgArea.value) return
  const distance = msgArea.value.scrollHeight - msgArea.value.scrollTop - msgArea.value.clientHeight
  if (distance < 50 && !autoScroll.value) {
    autoScroll.value = true
    showNewMessageTip.value = false
  }
}
```

**Remove ALL direct scroll assignments from:**
- `onThinking()` -- replace with `onNewContent()`
- `onToolCall()` -- replace with `onNewContent()`
- `syncMessages()` -- replace with `onNewContent()`

**Add floating toast component:**
```vue
<div v-if="showNewMessageTip" class="new-message-toast" @click="scrollToBottomAndResume">
  \u2193 \u65b0\u6d88\u606f
</div>
```

---

### Phase 2: Message Structure Refactor

**Current flat structure:**
```typescript
messages = [
  {id: 'msg1', content_type: 'text', content: 'User says hi'},
  {id: 'think1', content_type: 'thinking', content: 'Hmm...'},
  {id: 'tool1', content_type: 'tool_call', tool_name: 'search'},
  {id: 'msg2', content_type: 'text', content: 'Hello!'},
]
```

**New nested structure:**
```typescript
interface AgentMessage {
  id: string
  sender_id: string
  sender_name: string
  sender_type: 'agent'
  content: string           // main text content
  content_type: 'text'
  reasoning?: string        // thinking content (accumulated)
  tool_calls?: ToolCall[]   // tool calls (accumulated)
  is_generating: boolean    // stream active flag
  batch_id: string
  timestamp: string
  is_me: false
}

messages = [
  {id: 'msg1', content_type: 'text', content: 'User says hi'},
  {
    id: 'agent_xxx',
    sender_id: 'agent1',
    sender_name: 'Vic',
    content: '',              // starts empty, accumulates
    reasoning: '',            // accumulates thinking chunks
    tool_calls: [],           // accumulates tool calls
    is_generating: true,
    batch_id: 'batch_xxx',
    // ...
  }
]
```

**Merge logic in store (`chat.ts`):**
```typescript
function onMessagePush(msg: Message) {
  const list = messagesMap.value[msg.session_id] || []
  
  // If this is an Agent reply chunk with batch_id
  if (msg.batch_id && msg.sender_type === 'agent') {
    const existing = list.find(m => m.batch_id === msg.batch_id && m.sender_id === msg.sender_id)
    if (existing) {
      // Append to existing Agent message
      existing.content += msg.content || ''
      existing.is_generating = true
      return
    }
  }
  
  // New message
  list.push({...msg, is_generating: msg.sender_type === 'agent'})
}
```

**Frontend merge of transient messages:**
Remove `transient` filtering. Instead, thinking/tool_call WS events update the Agent message object in-place:
```typescript
function onThinking(e: CustomEvent) {
  const p = e.detail
  const agentMsg = messages.value.find(m => m.batch_id === p.batch_id && m.sender_id === p.agent_id)
  if (agentMsg) {
    agentMsg.reasoning = (agentMsg.reasoning || '') + p.thinking
  }
  onNewContent()
}
```

---

### Phase 3: Rendering

**New message template structure:**
```vue
<div class="msg-row them">
  <img :src="avatar" class="msg-avatar" />
  <div class="bubble">
    <div class="sender">Agent Name</div>
    
    <!-- Reasoning bar (collapsible) -->
    <div v-if="msg.reasoning" class="reasoning-bar" @click="toggleReasoning(msg.id)">
      <span>\u25bc \u5df2\u601d\u8003 {{ msg.reasoning.length }} \u5b57</span>
    </div>
    <div v-if="expanded[msg.id] && msg.reasoning" class="reasoning-body">
      {{ msg.reasoning }}
    </div>
    
    <!-- Tool calls bar -->
    <div v-if="msg.tool_calls?.length" class="tool-bar">
      <span v-for="t in msg.tool_calls" :key="t.name">
        \u25b6 {{ t.name }}
      </span>
    </div>
    
    <!-- Main content -->
    <div class="text" :class="{ 'typing-cursor': msg.is_generating && !msg.content }">
      {{ msg.content }}
    </div>
    
    <div class="time">{{ formatTime(msg.timestamp) }}</div>
  </div>
</div>
```

**CSS for typing effect:**
```css
.typing-cursor::after {
  content: '\u258c';
  animation: blink 1s step-end infinite;
  color: #00E5C9;
}
@keyframes blink {
  50% { opacity: 0; }
}
```

---

### Phase 4: Stream Typing Effect

**Backend (already streams):** No change needed. Backend already sends `chat.message` chunks via WS.

**Frontend accumulation:**
```typescript
// In onMessagePush / WS handler
if (msg.batch_id && msg.sender_type === 'agent') {
  const existing = findAgentMessage(msg.batch_id)
  if (existing) {
    existing.content += msg.content
    // Optional: character-by-character reveal with requestAnimationFrame
    typewriteReveal(existing, msg.content)
  }
}

function typewriteReveal(msg: AgentMessage, newChunk: string) {
  // Instead of instant assignment, reveal characters progressively
  const chars = newChunk.split('')
  let i = 0
  const reveal = () => {
    if (i < chars.length) {
      msg.display_content = (msg.display_content || '') + chars[i]
      i++
      requestAnimationFrame(reveal)
    }
  }
  reveal()
}
```

**Alternative (simpler):** CSS `opacity` transition on each character span. Less JS overhead.

---

## Files to Modify

| File | Changes |
|------|---------|
| `frontend/src/components/ChatView.vue` | New scroll logic, message structure, rendering template, CSS |
| `frontend/src/components/GroupChatView.vue` | Same as ChatView |
| `frontend/src/stores/chat.ts` | `onMessagePush` merge logic |
| `frontend/src/composables/useWebSocket.ts` | May need to adjust WS event routing for batch-based updates |

---

## Rollout Order

1. **Phase 1 (Scroll)** -- foundation, affects all message types
2. **Phase 2 (Message Structure)** -- requires Phase 1 for smooth UX
3. **Phase 3 (Rendering)** -- visual layer, can iterate independently
4. **Phase 4 (Typing Effect)** -- polish, optional delay

## Acceptance Criteria

- [ ] User can scroll up during Agent generation without being pulled down
- [ ] Floating `\u2193 \u65b0\u6d88\u606f` appears when new content arrives while scrolled up
- [ ] Clicking toast scrolls to bottom and resumes auto-scroll
- [ ] One Agent reply = one message bubble containing reasoning + tools + content
- [ ] Reasoning is collapsible, default collapsed
- [ ] Tool calls show as compact bars, expandable
- [ ] Content appears with smooth typing effect (or at minimum, progressive reveal)
- [ ] Same behavior in both ChatView (private) and GroupChatView (group)
