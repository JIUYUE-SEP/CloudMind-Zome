import { describe, it, expect } from "vitest";
import { classifyListenError, EADDRINUSE_EXIT_CODE } from "../../src/api/listen-error.js";

describe("api/listen-error（P0-3 EADDRINUSE）", () => {
  it("EADDRINUSE 分类为独立 exit code 2，提示端口占用", () => {
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    const classified = classifyListenError(err, 8848);
    expect(classified).not.toBeNull();
    expect(classified!.exitCode).toBe(EADDRINUSE_EXIT_CODE);
    expect(classified!.exitCode).toBe(2);
    expect(classified!.message).toContain("8848");
    expect(classified!.message).toContain("EADDRINUSE");
  });

  it("其他 listen 错误不分类（按原路径抛出，exit 1）", () => {
    expect(classifyListenError(new Error("boom"), 8848)).toBeNull();
    expect(classifyListenError(Object.assign(new Error("x"), { code: "EACCES" }), 8848)).toBeNull();
    expect(classifyListenError(undefined, 8848)).toBeNull();
  });
});
