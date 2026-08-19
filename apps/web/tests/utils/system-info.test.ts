import { describe, it, expect } from "vitest";
import { formatUptime } from "@/utils/system-info";

describe("formatUptime 运行时长人性化格式化", () => {
  it("60 秒内显示秒", () => {
    expect(formatUptime(0)).toBe("0 秒");
    expect(formatUptime(45)).toBe("45 秒");
  });

  it("60 分钟内显示分 + 秒，整分省略秒", () => {
    expect(formatUptime(60)).toBe("1 分钟");
    expect(formatUptime(200)).toBe("3 分 20 秒");
  });

  it("24 小时内显示小时 + 分，整点省略分", () => {
    expect(formatUptime(3600)).toBe("1 小时");
    expect(formatUptime(3661)).toBe("1 小时 1 分");
  });

  it("超过 24 小时显示天 + 小时", () => {
    expect(formatUptime(86400)).toBe("1 天");
    expect(formatUptime(90000)).toBe("1 天 1 小时");
  });

  it("负值与小数兜底：按 0 秒 / 向下取整", () => {
    expect(formatUptime(-5)).toBe("0 秒");
    expect(formatUptime(45.9)).toBe("45 秒");
  });
});
