import { createServer } from "./api/server.js";
import { AgentRepository } from "./memory/repositories/agent.js";
import { MessageRepository } from "./memory/repositories/message.js";
import { MemoryRepository } from "./memory/repositories/memory.js";
import { ActionRepository } from "./memory/repositories/action.js";
import { LLMCallRepository } from "./memory/repositories/llm-call.js";
import type { ApiContext } from "./api/context.js";

async function main() {
  const agentRepository = new AgentRepository();
  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    getAgentWorker: () => undefined,
  };

  const app = await createServer(context);
  await app.listen({ port: Number(process.env.PORT || 8848), host: "127.0.0.1" });
  const addr = app.server.address();
  const addrStr =
    typeof addr === "string"
      ? addr
      : addr
        ? `${addr.address}:${addr.port}`
        : "unknown";
  console.log(`Engine listening on ${addrStr}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
