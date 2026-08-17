import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function pathsOverlap(leftInput: string, rightInput: string): boolean {
  const left = canonicalizeThroughExistingAncestor(leftInput);
  const right = canonicalizeThroughExistingAncestor(rightInput);
  return isDescendantOrSame(left, right) ||
    isDescendantOrSame(right, left) ||
    sameExistingDirectory(left, right);
}

function sameExistingDirectory(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left, { bigint: true });
    const rightStat = statSync(right, { bigint: true });
    return leftStat.isDirectory() &&
      rightStat.isDirectory() &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw new Error("storage directory identity cannot be inspected safely", { cause: error });
  }
}

function canonicalizeThroughExistingAncestor(pathInput: string): string {
  let candidate = resolve(pathInput);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(candidate), ...missingSegments);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw new Error("storage path cannot be resolved safely", { cause: error });
      }
      try {
        lstatSync(candidate);
      } catch (statError) {
        if (!isFileSystemError(statError, "ENOENT")) {
          throw new Error("storage path cannot be inspected safely", { cause: statError });
        }
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw new Error("storage path has no resolvable ancestor", { cause: error });
        }
        missingSegments.unshift(basename(candidate));
        candidate = parent;
        continue;
      }
      throw new Error("storage path contains a dangling symbolic link", { cause: error });
    }
  }
}

function isDescendantOrSame(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
