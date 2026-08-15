import { describe, it, expect } from "vitest";
import { ErrorThrottle } from "../../src/plugins/log/error-throttle.js";

describe("ErrorThrottle（P4-4）", () => {
  it("首次立即记录；退避窗口内只计数；窗口到时带累计并加大退避", () => {
    let now = 0;
    const t = new ErrorThrottle({ now: () => now, initialBackoffMs: 1000, maxBackoffMs: 3000 });

    expect(t.hit("k")).toEqual({ count: 1, suppressed: 0 }); // 首次立即
    now = 100;
    expect(t.hit("k")).toBeUndefined(); // 窗口内折叠
    now = 900;
    expect(t.hit("k")).toBeUndefined();
    now = 1100;
    expect(t.hit("k")).toEqual({ count: 4, suppressed: 2 }); // 窗口到：带累计
    now = 2000;
    expect(t.hit("k")).toBeUndefined(); // 新退避 4s 未到期
    now = 5200;
    expect(t.hit("k")).toEqual({ count: 6, suppressed: 1 });
    // 退避封顶：1s → 4s → 3s(封顶 3000)
    now = 8300;
    expect(t.hit("k")).toEqual({ count: 7, suppressed: 0 });
  });

  it("不同 key 独立节流", () => {
    let now = 0;
    const t = new ErrorThrottle({ now: () => now, initialBackoffMs: 1000 });
    expect(t.hit("agent-a:err-1")).toBeDefined();
    expect(t.hit("agent-b:err-1")).toBeDefined(); // 不同 agent 各自首次
    expect(t.hit("agent-a:err-2")).toBeDefined(); // 不同原因各自首次
    now = 100;
    expect(t.hit("agent-a:err-1")).toBeUndefined();
    expect(t.hit("agent-a:err-2")).toBeUndefined();
  });

  it("recover：返回累计并清除，之后重新首次记录", () => {
    const t = new ErrorThrottle({ now: () => 0 });
    t.hit("k");
    t.hit("k");
    expect(t.recover("k")).toEqual({ count: 2, suppressed: 1 });
    expect(t.recover("k")).toBeUndefined(); // 已清除
    expect(t.hit("k")).toEqual({ count: 1, suppressed: 0 }); // 重新首次
  });

  it("recoverPrefix：只清匹配前缀的 key", () => {
    const t = new ErrorThrottle({ now: () => 0 });
    t.hit("task:t1:err-a");
    t.hit("task:t1:err-b");
    t.hit("task:t2:err-a");
    const recovered = t.recoverPrefix("task:t1:");
    expect(recovered.map((r) => r.key).sort()).toEqual(["task:t1:err-a", "task:t1:err-b"]);
    expect(t.recover("task:t2:err-a")).toBeDefined(); // t2 不受影响
  });
});
