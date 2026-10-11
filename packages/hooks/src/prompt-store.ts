import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type CurrentPrompt = { sessionId: string; turnId: string; text: string; expiresAt: number };
const ttl = 30 * 60 * 1_000;
const maxBytes = 256 * 1024;

export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.CPM_DATA_DIR) {
    if (!isAbsolute(env.CPM_DATA_DIR)) throw new Error('CPM_DATA_DIR_REQUIRED');
    return resolve(env.CPM_DATA_DIR);
  }
  if (!env.PLUGIN_DATA || !isAbsolute(env.PLUGIN_DATA)) throw new Error('CPM_DATA_DIR_REQUIRED');
  const hostRoot = resolve(env.PLUGIN_DATA);
  const info = lstatSync(hostRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(hostRoot) !== hostRoot ||
      (info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('CPM_PLUGIN_DATA_INVALID');
  }
  // The host owns PLUGIN_DATA and may create it as 0755. Only our fixed child is
  // private; never chmod the host root, migrate old files, or reuse its root DB.
  return join(hostRoot, 'kanban');
}

export function ensurePrivateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error('CPM_PRIVATE_DIRECTORY_REQUIRED');
  path = resolve(path);
  // Reject aliases before mkdir: checking only afterwards could already create
  // a child through a symlink outside the requested directory.
  let ancestor = path;
  while (true) {
    try {
      const info = lstatSync(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(ancestor) !== ancestor) {
        throw new Error('CPM_PRIVATE_DIRECTORY_REQUIRED');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) || realpathSync(path) !== resolve(path)) {
    throw new Error('CPM_PRIVATE_DIRECTORY_REQUIRED');
  }
  return path;
}

// A current-turn handoff, not a transcript store. This is local process isolation;
// file permissions do not authenticate a hostile process running as the same OS user.
export class CurrentPromptStore {
  private readonly directory: string;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    ensurePrivateDirectory(dataDir);
    this.directory = ensurePrivateDirectory(join(dataDir, 'current-prompts'));
    this.now = now;
    this.sweep();
  }

  private filename(sessionId: string): string {
    return join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  }

  record(input: Omit<CurrentPrompt, 'expiresAt'>, validUntil?: number): void {
    if (!input.sessionId || !input.turnId || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 128 * 1024) {
      throw new Error('CPM_INVALID_PROMPT');
    }
    const now = this.now();
    const expiresAt = Math.min(now + ttl, validUntil ?? now + ttl);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('CPM_INVALID_PROMPT_EXPIRY');
    const contents = JSON.stringify({ ...input, expiresAt });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.filename(input.sessionId));
    } finally {
      try { unlinkSync(temporary); } catch { /* already renamed or never created */ }
    }
  }

  private read(path: string): CurrentPrompt | null {
    let fd: number | undefined;
    try {
      const beforeOpen = lstatSync(path);
      if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size > maxBytes) return null;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())) return null;
      const input: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const record = input as CurrentPrompt;
      if (typeof record.sessionId !== 'string' || !record.sessionId || typeof record.turnId !== 'string' || !record.turnId ||
          typeof record.text !== 'string' || typeof record.expiresAt !== 'number' ||
          record.expiresAt <= this.now() || record.expiresAt - this.now() > ttl) return null;
      return record;
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  get(sessionId: string, turnId?: string): CurrentPrompt | null {
    const path = this.filename(sessionId);
    const record = this.read(path);
    if (!record) {
      try { unlinkSync(path); } catch { /* missing record is closed */ }
      return null;
    }
    return record.sessionId === sessionId && (!turnId || record.turnId === turnId) ? record : null;
  }

  clear(sessionId: string, turnId?: string): void {
    const record = this.get(sessionId);
    if (record && (!turnId || record.turnId === turnId)) unlinkSync(this.filename(sessionId));
  }

  sweep(): void {
    for (const name of readdirSync(this.directory)) {
      if (/^[a-f0-9-]{36}\.tmp$/.test(name)) {
        const temporary = join(this.directory, name);
        try { if (lstatSync(temporary).mtimeMs < this.now() - ttl) unlinkSync(temporary); } catch { /* worker already cleaned it */ }
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.directory, name);
      if (!this.read(path)) {
        try { unlinkSync(path); } catch { /* another local worker cleaned it */ }
      }
    }
  }
}
