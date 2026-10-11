import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export type SyntheticHookScope = { mode: 'synthetic-test'; cwd: string; sessionId: string; expiresAt: number };
export type BoundSyncScope = { mode: 'bound-sessions'; projectIds: string[] };
export type HookScope = SyntheticHookScope | BoundSyncScope;
const maxScopeBytes = 4_096;
const maxDurationMs = 30 * 60_000;

// This module only reads a human-authorized scope; it never enables, repairs or
// extends one. Private files constrain scope, not another process with the same
// OS identity. Host Hook trust remains a separate deployment prerequisite.
function readScopeFile(dataDir: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir) return null;
    const directory = lstatSync(dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(dataDir) !== dataDir ||
        (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) return null;
    const path = join(dataDir, 'hook-scope.json');
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxScopeBytes) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxScopeBytes || info.dev !== before.dev || info.ino !== before.ino || info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return null;
    const bytes = Buffer.alloc(maxScopeBytes + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > maxScopeBytes) return null;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function boundScope(scope: Record<string, unknown> | null): BoundSyncScope | undefined {
  if (!scope || scope.mode !== 'bound-sessions' || Object.keys(scope).some(key => !['mode', 'projectIds'].includes(key)) ||
      !Array.isArray(scope.projectIds) || scope.projectIds.length === 0 || scope.projectIds.length > 100 ||
      !scope.projectIds.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(id)) ||
      new Set(scope.projectIds).size !== scope.projectIds.length) return;
  return { mode: 'bound-sessions', projectIds: [...scope.projectIds] as string[] };
}

// For server/UI readiness. This proves configuration only, not host connection.
export function readBoundSyncScope(dataDir: string): BoundSyncScope | undefined {
  return boundScope(readScopeFile(dataDir));
}

export function readHookScope(dataDir: string, input: unknown, now = Date.now()): HookScope | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const event = input as Record<string, unknown>;
    if (typeof event.session_id !== 'string' || typeof event.cwd !== 'string') return null;
    if (event.agent_id != null || event.agent_type != null) return null;
    const scope = readScopeFile(dataDir);
    if (!scope) return null;
    if (scope.mode === 'bound-sessions') {
      if (!isAbsolute(event.cwd) || resolve(event.cwd) !== event.cwd || realpathSync(event.cwd) !== event.cwd ||
          !lstatSync(event.cwd).isDirectory()) return null;
      return boundScope(scope) ?? null;
    }
    if (Object.keys(scope).some(key => !['mode', 'cwd', 'sessionId', 'expiresAt'].includes(key)) ||
        scope.mode !== 'synthetic-test' || typeof scope.cwd !== 'string' || !isAbsolute(scope.cwd) ||
        typeof scope.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,240}$/.test(scope.sessionId) ||
        typeof scope.expiresAt !== 'string') return null;
    const expiresAt = Date.parse(scope.expiresAt);
    if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== scope.expiresAt ||
        expiresAt <= now || expiresAt - now > maxDurationMs) return null;
    if (event.cwd !== scope.cwd || event.session_id !== scope.sessionId || resolve(scope.cwd) !== scope.cwd ||
        realpathSync(scope.cwd) !== scope.cwd || !lstatSync(scope.cwd).isDirectory()) return null;
    return { mode: 'synthetic-test', cwd: scope.cwd, sessionId: scope.sessionId, expiresAt };
  } catch { return null; }
}
