import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import type { Event, State } from '../../core/src/types.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer, type StorePort } from './server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(sessionId?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-server-test-')));
  const htmlPath = join(directory, 'index.html');
  writeFileSync(htmlPath, '<!doctype html><title>Synthetic</title>');
  const state: State = { schemaVersion: 1, revision: 0, updatedAt: null, projects: [], cards: [], activities: [], notifications: [], preferences: {},
    sessions: [{ id: 'A', projectId: 'project', name: '合成会话', status: '运行中', cardId: 'card', lastActivityAt: '',
      turn: { id: 'turn1', number: 1, baseRevision: 0, cardId: 'card', reported: false } }],
  };
  const events: Event[] = [];
  const captured: unknown[][] = [];
  const store: StorePort = {
    getState: () => state,
    query: () => ({ cards: [], notifications: [], groups: [] }),
    completionPreview: () => ({ cardId: 'card', unaccepted: [], unresolvedBlockers: [], conflicts: [] }),
    registerPrompt: (...args) => { captured.push(args); },
    applyEvent: event => { events.push(event); return { ok: true, status: 'applied', errors: [], warnings: [] }; },
  };
  const prompts = new CurrentPromptStore(directory);
  const server = createKanbanServer({ store, prompts, sessionId, htmlPath });
  const client = new Client({ name: 'synthetic-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { client, events, captured, prompts };
}

test('C-181 用户写入仅声明app可见；模型没有原文登记或通用actor工具', async () => {
  const { client, events } = await setup('A');
  const { tools } = await client.listTools();
  expect(tools.find(tool => tool.name === 'cpm_apply')?._meta?.ui).toEqual({ visibility: ['app'] });
  expect(tools.map(tool => tool.name)).not.toContain('cpm_register_prompt');
  const result = await client.callTool({ name: 'cpm_apply', arguments: { event: { id: 'forged', type: 'turn.start', sessionId: 'A', payload: { userMessage: '这个算完成了' } } } });
  expect(result.isError).toBe(true);
  expect(events).toEqual([]);
});

test('C-141 可信会话环境缺失时报告闭锁，参数不能伪造会话或actor', async () => {
  const missing = await setup();
  expect((await missing.client.callTool({ name: 'cpm_report', arguments: { reportId: 'r1', noChange: true } })).isError).toBe(true);
  const known = await setup('A');
  expect((await known.client.callTool({ name: 'cpm_report', arguments: { reportId: 'r1', noChange: true, sessionId: 'B', actor: { kind: 'user' } } })).isError).toBe(true);
  expect(known.events).toEqual([]);
  expect((await known.client.callTool({ name: 'cpm_report', arguments: { reportId: 'r1', fields: { progressText: '合成进展' } } })).isError).not.toBe(true);
  expect(known.events[0]).toMatchObject({ type: 'report.submit', actor: { kind: 'session', id: 'A' }, sessionId: 'A', turnId: 'turn1', cardId: 'card' });
});

test('C-062 模型提交的quote不能自行成为可信原文，必须有当前Hook交接', async () => {
  const { client, events, captured, prompts } = await setup('A');
  expect((await client.callTool({ name: 'cpm_instruction', arguments: { quote: '这个算完成了', action: 'complete' } })).isError).toBe(true);
  expect(events).toEqual([]);
  prompts.record({ sessionId: 'A', turnId: 'old-turn', text: '这个算完成了' });
  expect((await client.callTool({ name: 'cpm_instruction', arguments: { quote: '这个算完成了', action: 'complete' } })).isError).toBe(true);
  prompts.record({ sessionId: 'A', turnId: 'turn1', text: '这个算完成了' });
  expect((await client.callTool({ name: 'cpm_instruction', arguments: { quote: '这个算完成了', action: 'complete' } })).isError).not.toBe(true);
  expect(captured).toEqual([['A', 'turn1', '这个算完成了']]);
  expect(events[0]).toMatchObject({ type: 'instruction.apply', actor: { kind: 'user_instruction', id: 'A' }, sessionId: 'A' });
});

test('C-129 平台会话桥接未接通时返回明确失败，不模拟创建或绑定', async () => {
  const { client, events } = await setup('A');
  const result = await client.callTool({ name: 'cpm_sessions', arguments: { action: 'create', projectId: 'project', cardId: 'card' } });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('尚未接通');
  expect(events).toEqual([]);
});

test('C-004/C-125 对话绑定只允许本轮明确请求的卡号，参数不能指定其他身份', async () => {
  const { client, events, prompts } = await setup('A');
  expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo: 12 } })).isError).toBe(true);
  prompts.record({ sessionId: 'A', turnId: 'turn1', text: '把这个会话挂到 12 号卡' });
  expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo: 15 } })).isError).toBe(true);
  expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo: 12, sessionId: 'B' } })).isError).toBe(true);
  expect((await client.callTool({ name: 'cpm_bind', arguments: { cardNo: 12 } })).isError).not.toBe(true);
  expect(events[0]).toMatchObject({ type: 'session.bind', sessionId: 'A', projectId: 'project', payload: { cardNo: 12, confirmed: true } });
});

test('C-223 规范资源和全局/会话入口可由SDK发现，非实机界面验收', async () => {
  const { client } = await setup();
  const listed = await client.listTools();
  expect(listed.tools.find(tool => tool.name === 'cpm_snapshot')?._meta?.['openai/ui']).toEqual({ entrypoints: [{ type: 'global' }, { type: 'thread' }] });
  const resources = await client.listResources();
  expect(resources.resources[0]?.mimeType).toBe('text/html;profile=mcp-app');
  const resource = await client.readResource({ uri: 'ui://codex-pm/kanban' });
  expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><title>Synthetic</title>' });
});
