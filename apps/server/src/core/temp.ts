const activePaths = new Set<string>();

export function trackTempPath(path: string): void {
  activePaths.add(path);
}

export function releaseTempPath(path: string): void {
  activePaths.delete(path);
}

export function isTempPathActive(path: string): boolean {
  return activePaths.has(path);
}

// Cleanup must not replace the deployment outcome, but persistent failures
// must be visible so an operator can remove the leftovers later.
export async function removeTempPath(
  path: string,
  remove: (path: string) => Promise<void>,
  warn: (message: string) => void,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await remove(path);
      return;
    } catch (error) {
      if (attempt === 3) {
        try {
          warn(`! 临时文件清理失败（已尝试 3 次）：${path}：${error instanceof Error ? error.message : String(error)}`);
        } catch { /* a failed observer must not replace the deployment outcome */ }
      } else {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
  }
}
