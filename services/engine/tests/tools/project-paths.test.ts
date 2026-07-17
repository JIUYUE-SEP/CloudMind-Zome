import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveProjectPath,
  validateProjectPath,
} from "../../src/tools/project-paths.js";

// 词法拒绝用例不涉及 fs，可用不存在的假 root；
// 放行用例会走到 realpath，必须用真实目录。
const FAKE_ROOT = "C:/data/projects/p1";

let tmpDir: string;
let PROJECT_ROOT: string;
let OUTSIDE_DIR: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-paths-test-"));
  PROJECT_ROOT = path.join(tmpDir, "root");
  OUTSIDE_DIR = path.join(tmpDir, "outside");
  await fs.mkdir(path.join(PROJECT_ROOT, "sub", "..hidden"), { recursive: true });
  await fs.mkdir(OUTSIDE_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTSIDE_DIR, "secret.txt"), "top secret");
  // Windows 下目录 junction 无需管理员权限；POSIX 为普通目录符号链接
  await fs.symlink(
    OUTSIDE_DIR,
    path.join(PROJECT_ROOT, "escape-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await fs.symlink(
    path.join(PROJECT_ROOT, "sub"),
    path.join(PROJECT_ROOT, "inside-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveProjectPath", () => {
  it("resolves a normal relative path under the project root", async () => {
    const result = await resolveProjectPath(PROJECT_ROOT, "sub/file.txt");
    expect(result).toBe(path.resolve(PROJECT_ROOT, "sub/file.txt"));
  });

  it('resolves "." to the project root itself', async () => {
    await expect(resolveProjectPath(PROJECT_ROOT, ".")).resolves.toBe(
      path.resolve(PROJECT_ROOT),
    );
  });

  it("resolves an empty relative path to the project root itself", async () => {
    await expect(resolveProjectPath(PROJECT_ROOT, "")).resolves.toBe(
      path.resolve(PROJECT_ROOT),
    );
  });

  it("resolves a not-yet-existing nested file path (new file write)", async () => {
    await expect(
      resolveProjectPath(PROJECT_ROOT, "newdir/newfile.txt"),
    ).resolves.toBe(path.resolve(PROJECT_ROOT, "newdir/newfile.txt"));
  });

  it("rejects path traversal with ../", async () => {
    await expect(resolveProjectPath(FAKE_ROOT, "../escape.ts")).rejects.toThrow(
      /path traversal detected/,
    );
  });

  it("rejects absolute paths", async () => {
    await expect(resolveProjectPath(FAKE_ROOT, "/etc/passwd")).rejects.toThrow(
      /absolute paths are not allowed/,
    );
  });

  it("rejects Windows absolute paths with different drive letter casing", async () => {
    if (process.platform !== "win32") return;

    await expect(
      resolveProjectPath(FAKE_ROOT, "C:/Windows/system.ini"),
    ).rejects.toThrow(/absolute paths are not allowed/);
    await expect(
      resolveProjectPath(FAKE_ROOT, "c:/windows/system.ini"),
    ).rejects.toThrow(/absolute paths are not allowed/);
  });

  it.each(["..", "../..", "../../etc/passwd", "sub/../../escape.ts"])(
    "rejects traversal via path.relative edge case: %s",
    async (input) => {
      await expect(resolveProjectPath(FAKE_ROOT, input)).rejects.toThrow(
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
  ])("allows path that resolves to the root or a subdirectory: %s", async (input) => {
    await expect(resolveProjectPath(PROJECT_ROOT, input)).resolves.toBeDefined();
  });

  it("allows ..hidden file or directory names", async () => {
    await expect(resolveProjectPath(PROJECT_ROOT, "..hidden")).resolves.toBeDefined();
    await expect(
      resolveProjectPath(PROJECT_ROOT, "sub/..hidden/file.txt"),
    ).resolves.toBeDefined();
  });

  it("resolves paths when projectRoot is a Windows drive root", async () => {
    if (process.platform !== "win32") return;

    await expect(resolveProjectPath("C:/", "file.txt")).resolves.toBe(
      path.resolve("C:/", "file.txt"),
    );
  });

  it("rejects cross-drive absolute paths", async () => {
    if (process.platform !== "win32") return;

    await expect(resolveProjectPath("C:/", "D:/file.txt")).rejects.toThrow(
      /absolute paths are not allowed/,
    );
  });
});

describe("resolveProjectPath symlink 逃逸防护", () => {
  it("rejects a symlinked directory pointing outside the root", async () => {
    await expect(
      resolveProjectPath(PROJECT_ROOT, "escape-link/secret.txt"),
    ).rejects.toThrow(/symlink escape/);
  });

  it("rejects a not-yet-existing file under an escaping symlink", async () => {
    await expect(
      resolveProjectPath(PROJECT_ROOT, "escape-link/newfile.txt"),
    ).rejects.toThrow(/symlink escape/);
  });

  it("rejects a symlinked file pointing outside the root (POSIX only)", async () => {
    if (process.platform === "win32") return; // Windows 文件 symlink 需管理员权限

    await fs.symlink(
      path.join(OUTSIDE_DIR, "secret.txt"),
      path.join(PROJECT_ROOT, "file-link.txt"),
    );
    await expect(resolveProjectPath(PROJECT_ROOT, "file-link.txt")).rejects.toThrow(
      /symlink escape/,
    );
  });

  it("allows a symlink that stays inside the root", async () => {
    await expect(
      resolveProjectPath(PROJECT_ROOT, "inside-link/file.txt"),
    ).resolves.toBe(path.resolve(PROJECT_ROOT, "inside-link/file.txt"));
  });
});

describe("validateProjectPath", () => {
  it("does not throw for safe paths", async () => {
    await expect(
      validateProjectPath(PROJECT_ROOT, "sub/file.txt"),
    ).resolves.toBeUndefined();
  });

  it("throws for escaping paths without returning a path", async () => {
    await expect(validateProjectPath(FAKE_ROOT, "../escape.ts")).rejects.toThrow(
      /path traversal detected/,
    );
  });
});
