import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeTopicCompressionConfig,
  DEFAULT_TOPIC_COMPRESSION_CONFIG,
  MIN_SEGMENT_MESSAGES,
} from "../../src/memory/topic/types.js";

describe("normalizeTopicCompressionConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("缺省返回默认配置", () => {
    expect(normalizeTopicCompressionConfig()).toEqual(DEFAULT_TOPIC_COMPRESSION_CONFIG);
    expect(normalizeTopicCompressionConfig({})).toEqual(DEFAULT_TOPIC_COMPRESSION_CONFIG);
  });

  it("messageThreshold 小于最短压缩段时 clamp 并 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeTopicCompressionConfig({ messageThreshold: 2 });
    expect(config.messageThreshold).toBe(MIN_SEGMENT_MESSAGES);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("windowMinutes 非正时回退默认并 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTopicCompressionConfig({ windowMinutes: 0 }).windowMinutes).toBe(
      DEFAULT_TOPIC_COMPRESSION_CONFIG.windowMinutes,
    );
    expect(normalizeTopicCompressionConfig({ windowMinutes: -5 }).windowMinutes).toBe(
      DEFAULT_TOPIC_COMPRESSION_CONFIG.windowMinutes,
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("hotMemoryCount 负数时归零", () => {
    expect(normalizeTopicCompressionConfig({ hotMemoryCount: -1 }).hotMemoryCount).toBe(0);
  });

  it("合法取值原样保留", () => {
    const config = normalizeTopicCompressionConfig({
      messageThreshold: 50,
      windowMinutes: 120,
      hotMemoryCount: 5,
      compressionModel: "k3-cheap",
    });
    expect(config.messageThreshold).toBe(50);
    expect(config.windowMinutes).toBe(120);
    expect(config.hotMemoryCount).toBe(5);
    expect(config.compressionModel).toBe("k3-cheap");
  });
});
