import path from "node:path";
import fs from "node:fs/promises";

function isPathInsideProjectRoot(resolvedRoot: string, fullPath: string): boolean {
  const resolvedPath = path.resolve(fullPath);

  if (process.platform === "win32") {
    // On Windows file paths are case-insensitive, so compare normalized lowercase
    // versions to prevent drive-letter casing or segment casing bypasses.
    const lowerRoot = resolvedRoot.toLowerCase();
    const lowerPath = resolvedPath.toLowerCase();
    const rootPrefix = lowerRoot.endsWith(path.sep)
      ? lowerRoot
      : lowerRoot + path.sep;

    return lowerPath === lowerRoot || lowerPath.startsWith(rootPrefix);
  }

  // On POSIX systems path resolution is case-sensitive; use path.relative to
  // detect traversal, matching the approach in read.ts.
  const rel = path.relative(resolvedRoot, resolvedPath);
  return !(rel === ".." || rel.startsWith("../"));
}

/**
 * realpath 的容错版：目标尚不存在时（如待写入的新文件），向上找最近的
 * 已存在祖先做 realpath，再把不存在的尾部拼回去。尾部段必然不存在，
 * 因此不可能是 symlink，拼接是安全的。
 */
async function realpathNearest(fullPath: string): Promise<string> {
  const tail: string[] = [];
  let current = fullPath;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export async function resolveProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new Error("absolute paths are not allowed");
  }

  const resolvedRoot = path.resolve(projectRoot);
  const fullPath = path.resolve(projectRoot, relativePath);

  if (!isPathInsideProjectRoot(resolvedRoot, fullPath)) {
    throw new Error("path traversal detected");
  }

  // 词法校验识别不了符号链接：root 内的 symlink（含依赖包、仓库自带）可能指向
  // root 外。对真实路径再做一次包含性比较，堵住 symlink 逃逸。
  const realRoot = await fs.realpath(resolvedRoot);
  const realTarget = await realpathNearest(fullPath);
  if (!isPathInsideProjectRoot(realRoot, realTarget)) {
    throw new Error("path traversal detected (symlink escape)");
  }

  return fullPath;
}

export async function validateProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<void> {
  await resolveProjectPath(projectRoot, relativePath);
}
