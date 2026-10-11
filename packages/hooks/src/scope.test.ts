import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import { CurrentPromptStore } from './prompt-store.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-hook-scope-'))); directories.push(directory);
  const cwd = join(directory, 'synthetic-project'); mkdirSync(cwd, { mode: 0o700 });
  const dataDir = join(directory, 'private-data');
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'synthetic-A', turn_id: 'T', cwd,
    prompt: '仅合成消息', transcript_path: '/must-not-read', model: 'synthetic-model', permission_mode: 'default' };
  const scope = { mode: 'synthetic-test', cwd, sessionId: 'synthetic-A', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const save = (value: unknown) => { mkdirSync(dataDir, { mode: 0o700, recursive: true }); writeFileSync(join(dataDir, 'hook-scope.json'), JSON.stringify(value), { mode: 0o600 }); };
  const run = (payload: unknown = input) => spawnSync(process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url))], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 5_000,
      env: { PATH: process.env.PATH ?? '', CPM_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1' },
    });
  return { directory, cwd, dataDir, input, scope, save, run };
}

test('C-062 合成范围许可缺失时正式Hook零写入，不自动创建目录或数据库', () => {
  const { dataDir, run } = setup();
  const result = run();
  expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  expect(existsSync(dataDir)).toBe(false);
});

test.each(['wrong-cwd', 'wrong-session', 'expired', 'too-long', 'invalid-mode', 'relative-cwd', 'wildcard', 'world-readable'])(
  'C-062 合成范围许可 %s 时不建立prompt或数据库', reason => {
    const { cwd, dataDir, scope, save, run } = setup();
    const changed = { ...scope };
    if (reason === 'wrong-cwd') changed.cwd = join(cwd, 'other');
    if (reason === 'wrong-session') changed.sessionId = 'other';
    if (reason === 'expired') changed.expiresAt = new Date(Date.now() - 1).toISOString();
    if (reason === 'too-long') changed.expiresAt = new Date(Date.now() + 31 * 60_000).toISOString();
    if (reason === 'invalid-mode') changed.mode = 'production';
    if (reason === 'relative-cwd') changed.cwd = './relative';
    if (reason === 'wildcard') changed.sessionId = '*';
    save(changed);
    if (reason === 'world-readable') chmodSync(join(dataDir, 'hook-scope.json'), 0o644);
    const before = readFileSync(join(dataDir, 'hook-scope.json'), 'utf8');
    const result = run();
    expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
    expect(readdirSync(dataDir)).toEqual(['hook-scope.json']);
    expect(readFileSync(join(dataDir, 'hook-scope.json'), 'utf8')).toBe(before);
  },
);

test.each(['scope-link', 'cwd-link', 'data-link', 'oversized', 'malformed'])(
  'C-062 合成范围许可 %s 拒绝路径别名或异常文件且不写业务数据', kind => {
    const { directory, cwd, dataDir, scope, save, run } = setup();
    if (kind === 'data-link') { const target = join(directory, 'elsewhere'); mkdirSync(target); symlinkSync(target, dataDir); }
    else save(scope);
    const path = join(dataDir, 'hook-scope.json');
    if (kind === 'scope-link') { rmSync(path); const target = join(directory, 'scope-target'); writeFileSync(target, JSON.stringify(scope), { mode: 0o600 }); symlinkSync(target, path); }
    if (kind === 'cwd-link') { const alias = join(directory, 'cwd-alias'); symlinkSync(cwd, alias); save({ ...scope, cwd: alias }); }
    if (kind === 'oversized') writeFileSync(path, ' '.repeat(4_097));
    if (kind === 'malformed') writeFileSync(path, '{');
    const result = run();
    expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
    expect(existsSync(join(dataDir, 'kanban.sqlite'))).toBe(false);
    expect(existsSync(join(dataDir, 'current-prompts'))).toBe(false);
  },
);

test.each(['agent_id', 'agent_type'])('C-062 正式Hook拒绝带%s的子agent输入，即使复用获准父sessionId', field => {
  const { dataDir, scope, input, save, run } = setup(); save(scope);
  const result = run({ ...input, [field]: 'synthetic-child' });
  expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  expect(readdirSync(dataDir)).toEqual(['hook-scope.json']);
});

test('C-062/C-145 正式Hook只接受获准合成会话，原话期限不超过scope并在Stop/Interrupt清除', () => {
  const { cwd, dataDir, scope, input, save, run } = setup(); save(scope);
  const store = new ProjectStore(join(dataDir, 'kanban.sqlite'));
  try {
    expect(store.applyEvent({ id: 'project', type: 'project.upsert', actor: { kind: 'user' }, payload: { id: 'P', name: '合成项目', folder: cwd } }).ok).toBe(true);
    const started = run({ ...input, hook_event_name: 'SessionStart', source: 'startup' });
    expect(started.status).toBe(0); expect(JSON.parse(started.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
    for (const [turn_id, hook_event_name] of [['T1', 'Stop'], ['T2', 'Interrupt']]) {
      const submitted = run({ ...input, turn_id });
      expect(submitted.status).toBe(0); expect(submitted.stderr).toBe('');
      expect(JSON.parse(submitted.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      const prompts = new CurrentPromptStore(dataDir);
      expect(prompts.get('synthetic-A', turn_id)?.expiresAt).toBe(Date.parse(scope.expiresAt));
      const stopped = run({ ...input, turn_id, hook_event_name, stop_hook_active: false, last_assistant_message: null });
      expect(stopped.status).toBe(0); expect(stopped.stdout).toBe(''); expect(stopped.stderr).toBe('');
      expect(prompts.get('synthetic-A', turn_id)).toBeNull();
    }
    expect(store.getState().sessions[0]?.status).toBe('空闲');
    expect(JSON.stringify(store.getState())).not.toContain(input.prompt);
    expect(JSON.stringify(store.getState())).not.toContain(input.transcript_path);
  } finally { store.close(); }
});
