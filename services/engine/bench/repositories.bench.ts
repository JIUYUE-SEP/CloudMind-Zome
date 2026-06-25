import { bench, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageRepository } from "../src/memory/repositories/message.js";
import { MemoryRepository } from "../src/memory/repositories/memory.js";
import { AgentRepository } from "../src/memory/repositories/agent.js";

const agentId = "bench-agent";

describe("Repositories", () => {
  let tmpDir: string;
  let agentRepo: AgentRepository;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-bench-"));
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    agentRepo = new AgentRepository();
  });

  afterEach(async () => {
    agentRepo.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.CLOUDMIND_DATA_DIR;
  });

  bench("MessageRepository append 100 messages", async () => {
    const repo = new MessageRepository(agentId);
    for (let i = 0; i < 100; i++) {
      await repo.append({
        id: `m${i}`,
        sessionId: "s1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: new Date().toISOString(),
      });
    }
  });

  bench("MemoryRepository append 100 memories", async () => {
    const repo = new MemoryRepository(agentId);
    for (let i = 0; i < 100; i++) {
      await repo.append({
        id: `mem${i}`,
        content: "memory content",
        embeddingId: `emb${i}`,
        createdAt: new Date().toISOString(),
      });
    }
  });

  bench("AgentRepository save + list 100 agents", async () => {
    for (let i = 0; i < 100; i++) {
      await agentRepo.save(`a${i}`, {
        id: `a${i}`,
        name: `A${i}`,
        persona: "",
        model: "mock",
        skills: [],
        tools: [],
      });
    }
    await agentRepo.list();
  });
});
