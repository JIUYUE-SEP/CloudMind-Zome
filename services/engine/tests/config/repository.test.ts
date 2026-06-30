import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigRepository } from "../../src/config/repository.js";

const ORIGINAL_DATA_DIR = process.env.CLOUDMIND_DATA_DIR;

describe("config/repository", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-repo-test-"));
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    if (ORIGINAL_DATA_DIR === undefined) {
      delete process.env.CLOUDMIND_DATA_DIR;
    } else {
      process.env.CLOUDMIND_DATA_DIR = ORIGINAL_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("saves and reloads provider apiKey consistently", async () => {
    const repo = new ConfigRepository();
    const config = {
      providers: [
        {
          id: "openai",
          displayName: "OpenAI",
          providerType: "openai" as const,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-plaintext-key",
          models: [],
        },
      ],
      settings: {
        memory: {
          compactThreshold: 0.8,
          keepRecent: 3,
          hotMemoryLimit: 10,
          warmMemoryLimit: 20,
        },
      },
    };

    await repo.save(config);
    const raw = await fs.readFile(path.join(tempDir, "config.json"), "utf-8");
    const saved = JSON.parse(raw);
    expect(saved.providers[0].apiKey).toMatch(/^enc:/);
    expect(saved.providers[0].apiKey).not.toContain("sk-plaintext-key");

    const loaded = await repo.load();
    expect(loaded.providers[0].apiKey).toBe("sk-plaintext-key");
  });

  it("encrypts tavilyApiKey on save", async () => {
    const repo = new ConfigRepository();
    const config = {
      providers: [],
      settings: {
        tavilyApiKey: "tvly-plaintext-key",
        memory: {
          compactThreshold: 0.8,
          keepRecent: 3,
          hotMemoryLimit: 10,
          warmMemoryLimit: 20,
        },
      },
    };

    await repo.save(config);
    const raw = await fs.readFile(path.join(tempDir, "config.json"), "utf-8");
    const saved = JSON.parse(raw);
    expect(saved.settings.tavilyApiKey).toMatch(/^enc:/);
    expect(saved.settings.tavilyApiKey).not.toContain("tvly-plaintext-key");

    const loaded = await repo.load();
    expect(loaded.settings.tavilyApiKey).toBe("tvly-plaintext-key");
  });

  it("remains backward compatible with plaintext apiKey", async () => {
    const repo = new ConfigRepository();
    const plainConfig = {
      providers: [
        {
          id: "openai",
          displayName: "OpenAI",
          providerType: "openai" as const,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "legacy-plain-key",
          models: [],
        },
      ],
      settings: {
        memory: {
          compactThreshold: 0.8,
          keepRecent: 3,
          hotMemoryLimit: 10,
          warmMemoryLimit: 20,
        },
      },
    };
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, "config.json"), JSON.stringify(plainConfig, null, 2));

    const loaded = await repo.load();
    expect(loaded.providers[0].apiKey).toBe("legacy-plain-key");
  });
});
