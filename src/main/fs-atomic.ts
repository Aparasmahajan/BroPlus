import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

/**
 * Crash-safe file write: the bytes go to a temp file next to `file`, are flushed
 * to disk, then renamed over it. A crash or power cut mid-write leaves either the
 * old file or the new one — never a truncated mix. On failure it throws and leaves
 * no temp file behind (and the old file untouched).
 */
export function writeFileAtomicSync(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Windows: a virus scanner or indexer briefly holding the target makes rename fail with EPERM/EBUSY. */
function renameWithRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until); // sync backoff: callers (store flush on quit) are synchronous
    }
  }
}
