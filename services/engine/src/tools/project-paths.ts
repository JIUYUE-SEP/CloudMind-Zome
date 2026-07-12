import path from "node:path";

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

export function resolveProjectPath(
  projectRoot: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("absolute paths are not allowed");
  }

  const resolvedRoot = path.resolve(projectRoot);
  const fullPath = path.resolve(projectRoot, relativePath);

  if (!isPathInsideProjectRoot(resolvedRoot, fullPath)) {
    throw new Error("path traversal detected");
  }

  return fullPath;
}

export function validateProjectPath(
  projectRoot: string,
  relativePath: string,
): void {
  resolveProjectPath(projectRoot, relativePath);
}
