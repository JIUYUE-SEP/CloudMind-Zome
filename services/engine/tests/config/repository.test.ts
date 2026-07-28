import { logger } from "../../src/logger.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigRepository } from "../../src/config/repository.js";

const ORIGINAL_DATA_DIR = process.env.CLOUDMIND_DATA_DIR;

describe("config/repository", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-repo-test-"));
    process.env.CLOUDMIND_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it("returns default config when file does not exist (ENOENT)", async () => {
    const repo = new ConfigRepository();
    const loaded = await repo.load();
    expect(loaded.providers).toEqual([]);
    expect(loaded.settings.memory).toEqual({
      compactThreshold: 0.8,
      keepRecent: 3,
      hotMemoryLimit: 10,
      warmMemoryLimit: 20,
    });
  });

  it("save writes via tmp + rename and leaves no tmp file behind", async () => {
    const repo = new ConfigRepository();
    const filePath = path.join(tempDir, "config.json");
    const renameSpy = vi.spyOn(fs, "rename");
    await repo.save({ providers: [], settings: { memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 } } });
    expect(renameSpy).toHaveBeenCalledWith(`${filePath}.tmp`, filePath);
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
  });

  it("keeps the original file intact when the tmp write crashes mid-save", async () => {
    const repo = new ConfigRepository();
    const filePath = path.join(tempDir, "config.json");
    const config = {
      providers: [
        {
          id: "openai",
          displayName: "OpenAI",
          providerType: "openai" as const,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-keep-me",
          models: [],
        },
      ],
      settings: {
        memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
      },
    };
    await repo.save(config);
    const before = await fs.readFile(filePath, "utf-8");

    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValueOnce(new Error("simulated crash"));
    await expect(repo.save(config)).rejects.toThrow("simulated crash");
    writeSpy.mockRestore();

    expect(await fs.readFile(filePath, "utf-8")).toBe(before);
  });

  it("throws and quarantines a corrupt config.json instead of silently falling back to defaults", async () => {
    const repo = new ConfigRepository();
    const filePath = path.join(tempDir, "config.json");
    const corruptContent = "{ this is not valid json";
    await fs.writeFile(filePath, corruptContent, "utf-8");

    await expect(repo.load()).rejects.toThrow(/配置文件损坏/);

    // 原文件被隔离成 config.json.corrupt-{timestamp}，内容原样保留
    const quarantined = (await fs.readdir(tempDir)).filter((f) =>
      f.startsWith("config.json.corrupt-"),
    );
    expect(quarantined).toHaveLength(1);
    expect(await fs.readFile(path.join(tempDir, quarantined[0]), "utf-8")).toBe(corruptContent);
    await expect(fs.access(filePath)).rejects.toThrow();

    // 后续 save 写新文件，绝不动隔离文件里的原始数据
    await repo.save({
      providers: [],
      settings: { memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 } },
    });
    expect(await fs.readFile(path.join(tempDir, quarantined[0]), "utf-8")).toBe(corruptContent);
  });

  it("warns and treats the field as unset when decrypting a stored apiKey fails", async () => {
    const repo = new ConfigRepository();
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        providers: [
          {
            id: "openai",
            displayName: "OpenAI",
            providerType: "openai",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "enc:!!!not-valid-ciphertext!!!",
            models: [],
          },
        ],
        settings: { memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 } },
      }),
      "utf-8",
    );

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const loaded = await repo.load();
    expect(loaded.providers[0].apiKey).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("serializes concurrent saves: none fails with ENOENT and no update is silently lost", async () => {
    const repo = new ConfigRepository();
    const filePath = path.join(tempDir, "config.json");
    const makeConfig = (id: string) => ({
      providers: [
        {
          id,
          displayName: id,
          providerType: "openai" as const,
          baseUrl: "https://api.openai.com/v1",
          apiKey: `sk-${id}`,
          models: [],
        },
      ],
      settings: { memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 } },
    });

    // 原实现固定 tmp 名：并发交错会 rename 撞 ENOENT 或覆盖到别人的内容
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) saves.push(repo.save(makeConfig(`p${i}`)));
    await Promise.all(saves); // 任何一个 reject（ENOENT 等）都会使本断言失败

    // 队列保证调用顺序即生效顺序：最终文件是最后一次 save 的完整内容
    const saved = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(saved.providers.map((p: { id: string }) => p.id)).toEqual(["p9"]);
  });

  it("blocks save after a load with decrypt failures, leaving the ciphertext file intact", async () => {
    const repo = new ConfigRepository();
    const filePath = path.join(tempDir, "config.json");
    const content = JSON.stringify({
      providers: [
        {
          id: "openai",
          displayName: "OpenAI",
          providerType: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "enc:!!!not-valid-ciphertext!!!",
          models: [],
        },
      ],
      settings: { memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 } },
    });
    await fs.writeFile(filePath, content, "utf-8");

    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const loaded = await repo.load();
    expect(loaded.providers[0].apiKey).toBeUndefined();

    // 降级 load 后的 save 会把 apiKey 永久写成 undefined：必须被阻断
    await expect(repo.save(loaded)).rejects.toThrow(/解密失败/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(content);
  });
});
