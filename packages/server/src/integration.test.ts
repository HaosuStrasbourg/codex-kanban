import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { ingestHook } from '../../hooks/src/ingress.ts';
import { createKanbanServer } from './server.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-full-integration-')));
  const dbPath = join(directory, 'kanban.sqlite');
  const store = new ProjectStore(dbPath);
  const hookStore = new ProjectStore(dbPath); // independent connection; no shared prompt memory
  const prompts = new CurrentPromptStore(directory);
  const hookPrompts = new CurrentPromptStore(directory);
  const htmlPath = join(directory, 'index.html');
  writeFileSync(htmlPath, '<!doctype html><title>Synthetic integration</title>');
  expect(store.applyEvent({ id: 'project', type: 'project.upsert', actor: { kind: 'user' }, payload: { id: 'P', name: '合成项目', folder: directory } }).ok).toBe(true);
  for (const title of ['第一张卡', '第二张卡']) expect(store.applyEvent({ id: randomUUID(), type: 'card.create', projectId: 'P', actor: { kind: 'user' }, payload: { title, acceptance: ['合成验收项'] } }).ok).toBe(true);
  const server = createKanbanServer({ store, prompts, sessionId: 'A', htmlPath });
  const client = new Client({ name: 'synthetic-host', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); store.close(); hookStore.close(); rmSync(directory, { recursive: true, force: true }); });
  const hook = (event: string, session: string, turn?: string, prompt?: string) => ingestHook({
    hook_event_name: event, session_id: session, cwd: directory, turn_id: turn, prompt,
    transcript_path: '/must-never-read/synthetic-only',
  }, { store: hookStore, prompts: hookPrompts });
  return { store, client, hook, prompts };
}

test('C-061/C-062/C-141 Hook至独立SQLite连接与SDK工具完整链路', async () => {
  const { store, client, hook, prompts } = await setup();
  hook('SessionStart', 'A');
  hook('UserPromptSubmit', 'A', 'bind-turn', '把这个会话挂到 1 号卡');
  expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo: 1 } })).isError).not.toBe(true);
  expect((await client.callTool({ name: 'cpm_report', arguments: { reportId: 'bind-report', noChange: true } })).isError).not.toBe(true);
  hook('Stop', 'A', 'bind-turn');
  hook('UserPromptSubmit', 'A', 'work-turn', '合成输入：请推进');
  expect((await client.callTool({ name: 'cpm_report', arguments: { reportId: 'work-report', fields: { status: '进行中', progressText: '合成进展', nextStep: '合成下一步' } } })).isError).not.toBe(true);
  expect(store.getState().cards[0]?.progressText).toBe('合成进展');
  hook('Stop', 'A', 'work-turn');
  hook('UserPromptSubmit', 'A', 'accept-turn', '这个算完成了');
  expect((await client.callTool({ name: 'cpm_instruction', arguments: { action: 'complete', quote: '伪造的文档原话' } })).isError).toBe(true);
  expect(store.getState().cards[0]?.status).toBe('进行中');
  expect((await client.callTool({ name: 'cpm_instruction', arguments: { action: 'complete', quote: '这个算完成了' } })).isError).not.toBe(true);
  expect(store.getState().cards[0]?.status).toBe('已完成');
  expect(store.getState().cards[0]?.acceptance[0]?.checked).toBe(false);
  expect(JSON.stringify(store.getState())).not.toContain('合成输入：请推进');
  hook('Stop', 'A', 'accept-turn');
  expect(prompts.get('A', 'accept-turn')).toBeNull();
  expect((await client.callTool({ name: 'cpm_instruction', arguments: { action: 'complete', quote: '这个算完成了' } })).isError).toBe(true);
});

test('C-004/C-126/C-127 运行中换绑保留旧卡报告，下一轮Hook提醒新卡', async () => {
  const { store, client, hook } = await setup();
  hook('SessionStart', 'A');
  hook('UserPromptSubmit', 'A', 'first', '绑定到 #1');
  expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo: 1 } })).isError).not.toBe(true);
  hook('Stop', 'A', 'first');
  hook('UserPromptSubmit', 'A', 'second', '绑定到 #2');
  expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo: 2 } })).isError).not.toBe(true);
  expect((await client.callTool({ name: 'cpm_report', arguments: { reportId: 'old-report', fields: { progressText: '属于旧卡' } } })).isError).not.toBe(true);
  expect(store.getState().cards[0]?.progressText).toBe('属于旧卡');
  expect(store.getState().cards[1]?.progressText).toBe('');
  hook('Stop', 'A', 'second');
  const response = hook('UserPromptSubmit', 'A', 'third', '合成：继续');
  expect(response?.hookSpecificOutput.additionalContext).toContain('当前卡片已改为 #2');
  expect(store.getState().sessions[0]?.cardId).toBe(store.getState().cards[1]?.id);
});

test('C-141 共享MCP进程按宿主每次_meta.threadId区分报告，不串写环境默认会话', async () => {
  const { store, client, hook } = await setup();
  for (const [session, cardNo] of [['A', 1], ['B', 2]] as const) {
    hook('SessionStart', session);
    hook('UserPromptSubmit', session, `turn-${session}`, `绑定到 #${cardNo}`);
    expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo }, _meta: { threadId: session } })).isError).not.toBe(true);
  }
  for (const session of ['A', 'B']) {
    expect((await client.callTool({ name: 'cpm_report', arguments: { reportId: `report-${session}`, fields: { progressText: `来自${session}` } }, _meta: { threadId: session } })).isError).not.toBe(true);
  }
  expect(store.getState().cards.map(card => card.progressText)).toEqual(['来自A', '来自B']);
  expect((await client.callTool({ name: 'cpm_report', arguments: { reportId: 'invalid-meta', noChange: true }, _meta: { threadId: '' } })).isError).toBe(true);
});

test('C-062 正式stdio进程忽略环境会话作为写入身份，Hook进程用临时数据目录', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-stdio-integration-')));
  const store = new ProjectStore(join(directory, 'kanban.sqlite'));
  expect(store.applyEvent({ id: 'P', type: 'project.upsert', actor: { kind: 'user' }, payload: { id: 'P', name: '合成项目', folder: directory } }).ok).toBe(true);
  const hookInput = { hook_event_name: 'UserPromptSubmit', session_id: 'synthetic-A', turn_id: 'synthetic-turn', cwd: directory, prompt: '合成消息，不含隐私', transcript_path: '/never/read' };
  const runtimeEnv = { PATH: process.env.PATH ?? '', CPM_DATA_DIR: directory, CODEX_THREAD_ID: 'synthetic-A', NODE_NO_WARNINGS: '1' };
  writeFileSync(join(directory, 'hook-scope.json'), JSON.stringify({ mode: 'synthetic-test', cwd: directory,
    sessionId: 'synthetic-A', expiresAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
  const hookResult = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../../hooks/src/index.ts', import.meta.url))], { env: runtimeEnv, input: JSON.stringify(hookInput), encoding: 'utf8', timeout: 5_000 });
  expect(hookResult.status).toBe(0);
  expect(hookResult.stderr).toBe('');
  expect(JSON.parse(hookResult.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  expect(store.getState().sessions[0]?.turn?.id).toBe('synthetic-turn');
  const client = new Client({ name: 'synthetic-stdio-host', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url))], env: runtimeEnv, stderr: 'pipe' });
  cleanups.push(async () => { await client.close(); await transport.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const snapshot = await client.callTool({ name: 'cpm_snapshot', arguments: {} });
  expect((snapshot.structuredContent as { capabilities: { threadIdentity: string } }).capabilities.threadIdentity).toBe('unavailable');
  expect((await client.callTool({ name: 'cpm_report', arguments: { reportId: 'synthetic', noChange: true } })).isError).toBe(true);
});
