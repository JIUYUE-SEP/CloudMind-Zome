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
      /escape\.ts/,
    );
  });

  it("rejects absolute paths", () => {
    expect(() => resolveProjectPath(PROJECT_ROOT, "/etc/passwd")).toThrow(
      /absolute paths are not allowed/,
    );
  });

  it("rejects Windows absolute paths with different drive letter casing", () => {
    expect(() => resolveProjectPath(PROJECT_ROOT, "C:/Windows/system.ini")).toThrow(
      /absolute paths are not allowed/,
    );
    expect(() => resolveProjectPath(PROJECT_ROOT, "c:/windows/system.ini")).toThrow(
      /absolute paths are not allowed/,
    );
  });

  it("rejects traversal via path.relative edge cases", () => {
    const cases = ["..", "../..", "../../etc/passwd", "sub/../../escape.ts"];
    for (const input of cases) {
      expect(() => resolveProjectPath(PROJECT_ROOT, input)).toThrow();
    }
  });

  it("allows paths that resolve to the root or its subdirectories", () => {
    const cases = [
      ".",
      "./",
      "sub/",
      "sub/..",
      "sub/file.txt",
      "sub/../sub/file.txt",
    ];
    for (const input of cases) {
      expect(() => resolveProjectPath(PROJECT_ROOT, input)).not.toThrow();
    }
  });
});

describe("validateProjectPath", () => {
  it("does not throw for safe paths", () => {
    expect(() => validateProjectPath(PROJECT_ROOT, "src/main.ts")).not.toThrow();
  });

  it("throws for escaping paths without returning a path", () => {
    expect(() => validateProjectPath(PROJECT_ROOT, "../escape.ts")).toThrow(
      /escape\.ts/,
    );
  });
});
