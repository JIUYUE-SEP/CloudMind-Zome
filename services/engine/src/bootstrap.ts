import { createServer } from "./api/server.js";
import { AgentRepository } from "./memory/repositories/agent.js";
import { MessageRepository } from "./memory/repositories/message.js";
import { MemoryRepository } from "./memory/repositories/memory.js";
import { ActionRepository } from "./memory/repositories/action.js";
import { LLMCallRepository } from "./memory/repositories/llm-call.js";
import { ConfigRepository } from "./config/repository.js";
import { OpenAIProvider, MockLLMProvider } from "./provider/llm.js";
import { AgentWorker } from "./core/agent-worker.js";
import { getBuiltinTools } from "./tools/builtin/index.js";
import type { ApiContext } from "./api/context.js";
import type { AgentConfig } from "@mindcloud/shared";
import { getAgentDir } from "./config/paths.js";

async function main() {
  const configRepo = new ConfigRepository();
  const agentRepository = new AgentRepository();
  const workers = new Map<string, AgentWorker>();

  async function getOrCreateWorker(agentId: string): Promise<AgentWorker | undefined> {
    const existing = workers.get(agentId);
    if (existing) return existing;

    const agentConfig = await agentRepository.get(agentId);
    if (!agentConfig) return undefined;

    const provider = await createProvider(agentConfig);
    const tools = getBuiltinTools().filter((t) => agentConfig.tools.includes(t.name));
    const workspaceDir = getAgentDir(agentId);

    const worker = new AgentWorker({
      agentId,
      model: agentConfig.modelId || agentConfig.model || "gpt-4o",
      provider,
      tools,
      workspaceDir,
      requiresApproval: () => false,
    });
    workers.set(agentId, worker);
    return worker;
  }

  async function createProvider(agentConfig: AgentConfig) {
    if (!agentConfig.providerId) {
      return new MockLLMProvider();
    }
    const config = await configRepo.load();
    const providerConfig = config.providers.find((p) => p.id === agentConfig.providerId);
    if (!providerConfig) {
      return new MockLLMProvider();
    }
    return new OpenAIProvider(providerConfig.apiKey, providerConfig.baseUrl);
  }

  const context: ApiContext = {
    agentRepository,
    getMessageRepository: (agentId: string) => new MessageRepository(agentId),
    getMemoryRepository: (agentId: string) => new MemoryRepository(agentId),
    getActionRepository: (agentId: string) => new ActionRepository(agentId),
    getLLMCallRepository: (agentId: string) => new LLMCallRepository(agentId),
    configRepository: configRepo,
    getAgentWorker: getOrCreateWorker,
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
