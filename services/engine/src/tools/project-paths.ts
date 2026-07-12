import path from "node:path";

function isPathInsideProjectRoot(projectRoot: string, fullPath: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(fullPath);

  if (process.platform === "win32") {
    // On Windows file paths are case-insensitive, so compare normalized lowercase
    // versions to prevent drive-letter casing or segment casing bypasses.
    const lowerRoot = resolvedRoot.toLowerCase();
    const lowerPath = resolvedPath.toLowerCase();

    return (
      lowerPath === lowerRoot ||
      lowerPath.startsWith(lowerRoot + path.sep)
    );
  }

  // On POSIX systems path resolution is case-sensitive; use path.relative to
  // detect traversal, matching the approach in read.ts.
  const rel = path.relative(resolvedRoot, resolvedPath);
  return !(rel.startsWith("..") || rel === "..");
}

export function resolveProjectPath(
  projectRoot: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("absolute paths are not allowed");
  }

  const fullPath = path.resolve(projectRoot, relativePath);

  if (!isPathInsideProjectRoot(projectRoot, fullPath)) {
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
