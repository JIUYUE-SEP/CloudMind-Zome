import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveProjectPath,
  validateProjectPath,
} from "../../src/tools/project-paths.js";

const PROJECT_ROOT = "C:/data/projects/p1";

describe("resolveProjectPath", () => {
  it("resolves a normal relative path under the project root", () => {
    const result = resolveProjectPath(PROJECT_ROOT, "src/main.ts");
    expect(result).toBe(path.resolve(PROJECT_ROOT, "src/main.ts"));
  });

  it('resolves "." to the project root itself', () => {
    expect(resolveProjectPath(PROJECT_ROOT, ".")).toBe(
      path.resolve(PROJECT_ROOT),
    );
  });

  it("resolves an empty relative path to the project root itself", () => {
    expect(resolveProjectPath(PROJECT_ROOT, "")).toBe(path.resolve(PROJECT_ROOT));
  });

  it("rejects path traversal with ../", () => {
    expect(() => resolveProjectPath(PROJECT_ROOT, "../escape.ts")).toThrow(
      /path traversal detected/,
    );
  });

  it("rejects absolute paths", () => {
    expect(() => resolveProjectPath(PROJECT_ROOT, "/etc/passwd")).toThrow(
      /absolute paths are not allowed/,
    );
  });

  it("rejects Windows absolute paths with different drive letter casing", () => {
    if (process.platform !== "win32") return;

    expect(() =>
      resolveProjectPath(PROJECT_ROOT, "C:/Windows/system.ini"),
    ).toThrow(/absolute paths are not allowed/);
    expect(() =>
      resolveProjectPath(PROJECT_ROOT, "c:/windows/system.ini"),
    ).toThrow(/absolute paths are not allowed/);
  });

  it.each(["..", "../..", "../../etc/passwd", "sub/../../escape.ts"])(
    "rejects traversal via path.relative edge case: %s",
    (input) => {
      expect(() => resolveProjectPath(PROJECT_ROOT, input)).toThrow(
        /path traversal detected/,
      );
    },
  );

  it.each([
    ".",
    "./",
    "sub/",
    "sub/..",
    "sub/file.txt",
    "sub/../sub/file.txt",
  ])("allows path that resolves to the root or a subdirectory: %s", (input) => {
    expect(() => resolveProjectPath(PROJECT_ROOT, input)).not.toThrow();
  });

  it("allows ..hidden file or directory names", () => {
    expect(() => resolveProjectPath(PROJECT_ROOT, "..hidden")).not.toThrow();
    expect(() =>
      resolveProjectPath(PROJECT_ROOT, "sub/..hidden/file.txt"),
    ).not.toThrow();
  });

  it("resolves paths when projectRoot is a Windows drive root", () => {
    if (process.platform !== "win32") return;

    expect(() => resolveProjectPath("C:/", "file.txt")).not.toThrow();
    expect(resolveProjectPath("C:/", "file.txt")).toBe(
      path.resolve("C:/", "file.txt"),
    );
  });

  it("rejects cross-drive absolute paths", () => {
    if (process.platform !== "win32") return;

    expect(() => resolveProjectPath("C:/", "D:/file.txt")).toThrow(
      /absolute paths are not allowed/,
    );
  });
});

describe("validateProjectPath", () => {
  it("does not throw for safe paths", () => {
    expect(() => validateProjectPath(PROJECT_ROOT, "src/main.ts")).not.toThrow();
  });

  it("throws for escaping paths without returning a path", () => {
    expect(() => validateProjectPath(PROJECT_ROOT, "../escape.ts")).toThrow(
      /path traversal detected/,
    );
  });
});
