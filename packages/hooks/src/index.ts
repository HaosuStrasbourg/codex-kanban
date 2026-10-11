import { join, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { ProjectStore } from '../../core/src/index.ts';
import { CurrentPromptStore, ensurePrivateDirectory, resolveDataDir } from './prompt-store.ts';
import { ingestHook } from './ingress.ts';
import { readHookScope } from './scope.ts';

export { ingestHook } from './ingress.ts';
export { CurrentPromptStore } from './prompt-store.ts';
export { readBoundSyncScope } from './scope.ts';

export function readHookInput(input: Readable): Promise<unknown> {
  return new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError); input.pause();
      if (code) { reject(new Error(code)); return; }
      try { resolveInput(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new Error('CPM_HOOK_INVALID_INPUT')); }
    };
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 256 * 1024) finish('CPM_HOOK_INPUT_LIMIT');
      else chunks.push(value);
    };
    const onEnd = () => finish();
    const onError = () => finish('CPM_HOOK_INPUT_ERROR');
    const timer = setTimeout(() => finish('CPM_HOOK_INPUT_TIMEOUT'), 1_800);
    input.on('data', onData); input.once('end', onEnd); input.once('error', onError); input.resume();
  });
}

export async function runHook(): Promise<void> {
  const input = await readHookInput(process.stdin);
  const dataDir = resolveDataDir();
  const scope = readHookScope(dataDir, input);
  if (!scope) return;
  ensurePrivateDirectory(dataDir);
  const dbPath = join(dataDir, 'kanban.sqlite');
  if (scope.mode === 'bound-sessions') {
    // Binding must already exist. A production Hook never creates a new store.
    try {
      const info = lstatSync(dbPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(dbPath) !== dbPath ||
          (process.getuid && info.uid !== process.getuid())) return;
    } catch { return; }
  }
  const prompts = scope.mode === 'synthetic-test' ? new CurrentPromptStore(dataDir) : undefined;
  const store = new ProjectStore(dbPath, { busyTimeoutMs: 500 });
  try {
    const response = ingestHook(input, { store, prompts, scope,
      promptExpiresAt: scope.mode === 'synthetic-test' ? scope.expiresAt : undefined });
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  } finally { store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timer = setTimeout(() => { process.stderr.write('CPM_HOOK_TIMEOUT\n'); process.exit(0); }, 2_500);
  try { await runHook(); }
  catch { process.stderr.write('CPM_HOOK_FAILED\n'); }
  finally { clearTimeout(timer); process.stdin.destroy(); process.exitCode = 0; }
}
