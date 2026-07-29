import { describe, it, expect } from "vitest";
import { resolveCommandShim } from "../../../src/tools/mcp/shim.js";

describe("resolveCommandShim", () => {
  it("非 win32 原样透传", () => {
    expect(resolveCommandShim("npx", ["-y", "pkg"], "linux")).toEqual({
      command: "npx",
      args: ["-y", "pkg"],
    });
  });

  it("win32 裸命令名包 cmd.exe /c（npx 等 .cmd shim 无 shell 无法 spawn）", () => {
    expect(resolveCommandShim("npx", ["-y", "pkg"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "npx", "-y", "pkg"],
    });
  });

  it("win32 显式 .cmd/.bat 也包 cmd.exe /c", () => {
    expect(resolveCommandShim("C:\\tools\\server.cmd", ["--x"], "win32").command).toBe("cmd.exe");
    expect(resolveCommandShim("C:\\tools\\server.bat", [], "win32").command).toBe("cmd.exe");
  });

  it("win32 真实 .exe 直通", () => {
    expect(resolveCommandShim("C:\\node\\node.exe", ["a.js"], "win32")).toEqual({
      command: "C:\\node\\node.exe",
      args: ["a.js"],
    });
  });

  it("默认 args 为空数组", () => {
    expect(resolveCommandShim("uvx", undefined, "win32").args).toEqual(["/c", "uvx"]);
  });
});
