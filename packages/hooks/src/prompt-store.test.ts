import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, expect, test } from 'vitest';
import { CurrentPromptStore, ensurePrivateDirectory, resolveDataDir } from './prompt-store.ts';

const directories: string[] = [];
function temporary() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-prompt-test-'))); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('C-062 本机仅当前轮原文，错会话或回合无法读作授权', () => {
  const directory = temporary();
  const prompts = new CurrentPromptStore(directory, () => 1_000);
  prompts.record({ sessionId: 'synthetic-A', turnId: 'synthetic-turn-1', text: '这个算完成了' });
  expect(prompts.get('synthetic-A', 'synthetic-turn-1')?.text).toBe('这个算完成了');
  expect(prompts.get('synthetic-A', 'wrong-turn')).toBeNull();
  expect(prompts.get('other-session', 'synthetic-turn-1')).toBeNull();
  prompts.record({ sessionId: 'synthetic-A', turnId: 'synthetic-turn-2', text: '第1项验收通过' });
  expect(prompts.get('synthetic-A', 'synthetic-turn-1')).toBeNull();
  const files = readdirSync(join(directory, 'current-prompts'));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(directory, 'current-prompts', files[0]!), 'utf8')).not.toContain('这个算完成了');
  expect(statSync(join(directory, 'current-prompts', files[0]!)).mode & 0o777).toBe(0o600);
});

test('C-145 Stop/Interrupt 清除对应轮原文，不清除随后新一轮', () => {
  const prompts = new CurrentPromptStore(temporary(), () => 1_000);
  prompts.record({ sessionId: 'A', turnId: 't2', text: '合成消息' });
  prompts.clear('A', 't1');
  expect(prompts.get('A', 't2')).not.toBeNull();
  prompts.clear('A', 't2');
  expect(prompts.get('A', 't2')).toBeNull();
});

test('C-062 过期原文自动清理，lease 不超过30分钟', () => {
  let now = 1_000;
  const directory = temporary();
  const prompts = new CurrentPromptStore(directory, () => now);
  prompts.record({ sessionId: 'A', turnId: 't1', text: '合成消息' });
  now += 30 * 60 * 1_000 + 1;
  expect(prompts.get('A', 't1')).toBeNull();
  expect(readdirSync(join(directory, 'current-prompts'))).toEqual([]);
});

test('C-062 未配置隔离目录或目录为符号链接时拒绝启动', () => {
  expect(() => resolveDataDir({})).toThrow();
  expect(() => resolveDataDir({ CPM_DATA_DIR: './relative' })).toThrow();
  const directory = temporary();
  const link = join(directory, 'alias');
  symlinkSync(directory, link);
  expect(() => new CurrentPromptStore(link)).toThrow();
});

test('C-062 显式CPM_DATA_DIR路径不变，PLUGIN_DATA只解析到自有kanban子目录', () => {
  const hostRoot = temporary();
  const explicit = join(hostRoot, 'explicit-private');
  expect(resolveDataDir({ CPM_DATA_DIR: explicit, PLUGIN_DATA: hostRoot })).toBe(explicit);
  expect(resolveDataDir({ PLUGIN_DATA: hostRoot })).toBe(join(hostRoot, 'kanban'));
  expect(() => resolveDataDir({ PLUGIN_DATA: './relative' })).toThrow();
});

test('C-062 拒绝宿主根或子路径符号链接，拒绝现存0755自有目录且不chmod', () => {
  const hostRoot = temporary();
  const elsewhere = temporary();
  const hostAlias = join(hostRoot, 'host-alias');
  symlinkSync(elsewhere, hostAlias);
  expect(() => ensurePrivateDirectory(resolveDataDir({ PLUGIN_DATA: hostAlias }))).toThrow();
  expect(existsSync(join(elsewhere, 'kanban'))).toBe(false);
  expect(() => ensurePrivateDirectory(join(hostAlias, 'explicit-child'))).toThrow();
  expect(existsSync(join(elsewhere, 'explicit-child'))).toBe(false);
  const owned = join(hostRoot, 'kanban');
  mkdirSync(owned, { mode: 0o755 });
  chmodSync(owned, 0o755);
  expect(() => ensurePrivateDirectory(resolveDataDir({ PLUGIN_DATA: hostRoot }))).toThrow();
  expect(statSync(owned).mode & 0o777).toBe(0o755);
});

test('C-062 正式stdio与Hook共用0755宿主根下的新0700目录，不修改旧根数据', async () => {
  const hostRoot = temporary();
  chmodSync(hostRoot, 0o755);
  const previousData = join(hostRoot, 'kanban.sqlite');
  writeFileSync(previousData, 'synthetic-existing-root-data');
  const runtimeEnv = { PATH: process.env.PATH ?? '', PLUGIN_DATA: hostRoot, NODE_NO_WARNINGS: '1' };
  const client = new Client({ name: 'synthetic-plugin-data-host', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--experimental-strip-types', fileURLToPath(new URL('../../server/src/index.ts', import.meta.url))],
    env: runtimeEnv, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const created = await client.callTool({ name: 'cpm_apply', arguments: { event: {
      id: 'synthetic-project', type: 'project.upsert', payload: { id: 'P', name: '合成项目', folder: hostRoot },
    } } });
    expect(created.isError).not.toBe(true);
    writeFileSync(join(hostRoot, 'kanban', 'hook-scope.json'), JSON.stringify({
      mode: 'synthetic-test', cwd: hostRoot, sessionId: 'synthetic-A', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { mode: 0o600 });
    const hookResult = spawnSync(process.execPath,
      ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url))], {
        env: runtimeEnv, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'synthetic-A',
          turn_id: 'synthetic-turn', cwd: hostRoot, prompt: '合成测试消息' }), encoding: 'utf8', timeout: 5_000,
      });
    expect(hookResult.status).toBe(0);
    expect(hookResult.stderr).toBe('');
    expect(JSON.parse(hookResult.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const snapshot = await client.callTool({ name: 'cpm_snapshot', arguments: {} });
    expect((snapshot.structuredContent as { state: { sessions: { id: string }[] } }).state.sessions[0]?.id).toBe('synthetic-A');
    const privateRoot = join(hostRoot, 'kanban');
    expect(statSync(hostRoot).mode & 0o777).toBe(0o755);
    expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(privateRoot, 'current-prompts')).mode & 0o777).toBe(0o700);
    expect(readFileSync(previousData, 'utf8')).toBe('synthetic-existing-root-data');
    expect(existsSync(join(privateRoot, 'kanban.sqlite'))).toBe(true);
  } finally { await client.close(); await transport.close(); }
});
