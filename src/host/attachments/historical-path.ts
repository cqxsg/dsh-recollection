import { win32 } from 'node:path';

/** The supported execution filesystem is Windows. A rooted spelling such as
 * /file or \\file still needs a drive/share; isAbsolute alone is insufficient. */
export function fullyQualifiedWindowsPath(path: string): boolean {
  return !path.includes('\0') && win32.isAbsolute(path) && win32.parse(path).root.length > 1;
}

/** Never let the live process or its per-drive environment fill a historical gap.
 * Keep the original spelling: the filesystem provider still owns resolution. */
export function historicalPathAvailable(path: string, cwd?: string): boolean {
  if (!path || path.includes('\0')) return false;
  if (fullyQualifiedWindowsPath(path)) return true;
  if (!cwd || !fullyQualifiedWindowsPath(cwd)) return false;
  const drive = /^[a-z]:/i.exec(path)?.[0];
  // Native win32.resolve treats namespace/UNC roots as different devices from
  // C:. Only an ordinary same-drive cwd proves a C:relative target.
  return !drive || cwd.slice(0, 2).toLowerCase() === drive.toLowerCase();
}
