import { describe, it, expect } from "vitest";
import { flushStdout } from "../src/flush-stdout.js";

describe("flushStdout（M51 退出前冲刷范式）", () => {
  it("正常 resolve：空写回调在既有缓冲 flush 后触发，不抛错", async () => {
    await expect(flushStdout()).resolves.toBeUndefined();
  });

  it("多次连续调用互不干扰（bootstrap/http 两处复用同一语义）", async () => {
    await expect(Promise.all([flushStdout(), flushStdout()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
