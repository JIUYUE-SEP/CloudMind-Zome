import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyListenError, EADDRINUSE_EXIT_CODE } from "../../src/api/listen-error.js";

const mocks = vi.hoisted(() => ({ execSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execSync: mocks.execSync }));

import { getGitShortHash } from "../../src/git-commit.js";

describe("api/listen-error（P0-3 EADDRINUSE）", () => {
  beforeEach(() => {
    mocks.execSync.mockReset();
  });

  it("S1：getGitShortHash 在 git 可用时返回 trim 后的短哈希", () => {
    mocks.execSync.mockReturnValue("940f500\n");
    expect(getGitShortHash()).toBe("940f500");
    // F4：固定 engine 源码目录 cwd、2s 超时、windowsHide，防启动挂起/闪窗/目录漂移
    expect(mocks.execSync).toHaveBeenCalledWith(
      "git rev-parse --short HEAD",
      expect.objectContaining({
        cwd: expect.stringMatching(/services[\\/]engine[\\/]src/),
        timeout: 2000,
        windowsHide: true,
      }),
    );
  });

  it("S1：getGitShortHash 在 git 缺失/失败时返回 undefined 不抛错（启动不崩）", () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error("git not found");
    });
    expect(getGitShortHash()).toBeUndefined();
  });

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

  it("S1：收编复用提示带当前进程代码版本（判别新旧），缺省回落 unknown", () => {
    const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    const classified = classifyListenError(err, 8848, "abc1234");
    expect(classified!.message).toContain("收编复用");
    expect(classified!.message).toContain("abc1234");

    const noVersion = classifyListenError(err, 8848);
    expect(noVersion!.message).toContain("当前进程代码版本：unknown");
  });
});
