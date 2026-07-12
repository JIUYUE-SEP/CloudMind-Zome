import path from "node:path";

function isPathInsideProjectRoot(projectRoot: string, fullPath: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(fullPath);

  // On Windows file paths are case-insensitive, so compare normalized lowercase
  // versions to prevent drive-letter casing or segment casing bypasses.
  const lowerRoot = resolvedRoot.toLowerCase();
  const lowerPath = resolvedPath.toLowerCase();

  return (
    lowerPath === lowerRoot ||
    lowerPath.startsWith(lowerRoot + path.sep.toLowerCase())
  );
}

export function resolveProjectPath(
  projectRoot: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`absolute paths are not allowed: ${relativePath}`);
  }

  const fullPath = path.resolve(projectRoot, relativePath);

  if (!isPathInsideProjectRoot(projectRoot, fullPath)) {
    throw new Error(`path is outside project root: ${relativePath}`);
  }

  return fullPath;
}

export function validateProjectPath(
  projectRoot: string,
  relativePath: string,
): void {
  resolveProjectPath(projectRoot, relativePath);
}
