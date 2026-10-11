import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import type { Card, Event, QueryResult, Result, State } from '../../core/src/types.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer } from './server.ts';
import type { HostThread } from './host-metadata.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(initial: Record<string, unknown> = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-planning-server-')));
  const store = new ProjectStore(':memory:');
  let sequence = 0;
  const apply = (type: Event['type'], payload: Record<string, unknown>, extra: Partial<Event> = {}) => {
    const outcome = store.applyEvent({ id: `setup-${++sequence}`, type, actor: { kind: 'system' }, payload, ...extra });
    expect(outcome.ok, outcome.errors.join()).toBe(true);
    return outcome;
  };
  apply('project.upsert', { id: 'P', name: '合成计划项目', folder: directory });
  apply('card.create', { id: 'bound', title: '已绑定卡片', acceptance: ['仍需用户验收'], ...initial }, { actor: { kind: 'user' }, projectId: 'P' });
  apply('session.upsert', { id: 'issuer', projectId: 'P', name: '合成发起会话' });
  apply('session.bind', {}, { actor: { kind: 'user' }, sessionId: 'issuer', cardId: 'bound' });
  apply('turn.start', {}, { sessionId: 'issuer', turnId: 'issuer-turn' });
  const thread: HostThread = { id: 'issuer', name: '合成发起会话', projectId: 'host-P', canonicalProjectId: 'host-P', cwd: directory,
    createdAt: 1, updatedAt: 2, recencyAt: null, status: 'active', assignment: 'canonical' };
  const hostMetadata = { list: async () => ({ project: { id: 'host-P', name: '合成计划项目', roots: [directory] }, threads: [thread] }),
    verify: async (folder: string, threadId: string) => { if (folder !== directory || threadId !== thread.id) throw Error('synthetic scope rejected'); return thread; } };
  const htmlPath = join(directory, 'index.html');
  writeFileSync(htmlPath, '<title>合成计划字段测试</title>');
  const server = createKanbanServer({ store, prompts: new CurrentPromptStore(directory), dataDir: directory, htmlPath, hostMetadata });
  const client = new Client({ name: 'planning-mcp-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  cleanup.push(async () => { await client.close(); await server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (name: string, args: Record<string, unknown>, issuer = 'issuer') => client.callTool({ name, arguments: args, _meta: { threadId: issuer } });
  const card = () => store.getState().cards.find(item => item.id === 'bound')!;
  return { store, apply, call, card, client };
}

test('C-420 MCP代办建卡接受跟进人与合法带时区时间，初始状态和AI归属保持', async () => {
  const x = await fixture();
  const response = await x.call('cpm_create_card', { requestId: 'create-planning', title: '等待排期', followUpOwner: '小林',
    followUpAt: '2028-02-29T09:30:45.123+08:00', dueDate: '2028-03-01', acceptance: ['真实交付证据'] });
  expect(response.isError).not.toBe(true);
  const card = (response.structuredContent as { card: Card }).card;
  expect(card).toMatchObject({ title: '等待排期', followUpOwner: '小林', followUpAt: '2028-02-29T09:30:45.123+08:00', dueDate: '2028-03-01', status: '未开始',
    acceptance: [{ checked: false, source: { kind: 'assistant', id: 'issuer' } }] });
  expect(x.store.getState().activities.at(-1)?.actor).toMatchObject({ kind: 'assistant', id: 'issuer' });
});

test('C-421 MCP建卡省略跟进字段默认我和空时间，快照返回两个字段', async () => {
  const x = await fixture();
  const created = await x.call('cpm_create_card', { requestId: 'defaults', title: '默认跟进' });
  expect(created.isError).not.toBe(true);
  const card = (created.structuredContent as { card: Card }).card;
  expect(card).toMatchObject({ followUpOwner: '我', followUpAt: null, dueDate: null });
  const response = await x.call('cpm_snapshot', {});
  const snapshot = response.structuredContent as { state: State; query: QueryResult };
  expect(snapshot.state.cards.find(item => item.id === card.id)).toMatchObject({ followUpOwner: '我', followUpAt: null });
  expect(snapshot.query.cards.find(item => item.id === card.id)).toMatchObject({ followUpOwner: '我', followUpAt: null });
});

test('C-422 MCP建卡允许明确清空跟进字段，幂等请求不能偷偷更改新字段', async () => {
  const x = await fixture();
  const args = { requestId: 'empty-follow-up', title: '未指定跟进', followUpOwner: '', followUpAt: null };
  const first = await x.call('cpm_create_card', args);
  expect(first.isError).not.toBe(true);
  expect((first.structuredContent as { card: Card }).card).toMatchObject({ followUpOwner: '', followUpAt: null });
  const before = x.store.getState();
  expect((await x.call('cpm_create_card', args)).isError).not.toBe(true);
  expect(x.store.getState()).toEqual(before);
  for (const changed of [{ followUpOwner: '另一个人' }, { followUpAt: '2026-10-06T09:00Z' }]) {
    expect((await x.call('cpm_create_card', { ...args, ...changed })).isError).toBe(true);
    expect(x.store.getState()).toEqual(before);
  }
});

test('C-423 MCP创建入口拒绝错误跟进类型和非法日期时间，业务状态不变', async () => {
  const x = await fixture(), before = x.store.getState();
  const invalid = ['2026-02-30T09:00+08:00', '2026-10-06T24:00+08:00', '2026-10-06T09:60Z', '2026-10-06T09:00:60Z',
    '2026-10-06T09:00', '2026-10-06', '2026-10-06T09:00+24:00', '2026-10-06T09:00:00.1234Z', '', 42];
  for (const followUpAt of invalid) {
    expect((await x.call('cpm_create_card', { requestId: 'invalid-time', title: '不写入', followUpAt })).isError).toBe(true);
    expect(x.store.getState()).toEqual(before);
  }
  expect((await x.call('cpm_create_card', { requestId: 'invalid-owner', title: '不写入', followUpOwner: null })).isError).toBe(true);
  expect(x.store.getState()).toEqual(before);
});

test('C-424 新跟进字段不能夹带status、actor或id绕过AI建卡权限', async () => {
  const x = await fixture(), before = x.store.getState();
  for (const extra of [{ status: '计划中' }, { status: '已完成' }, { actor: { kind: 'user' } }, { id: 'forged' }]) {
    expect((await x.call('cpm_create_card', { requestId: 'forbidden', title: '不越权', followUpOwner: '我', followUpAt: null, ...extra })).isError).toBe(true);
    expect(x.store.getState()).toEqual(before);
  }
});

test('C-425 MCP报告更改跟进字段须原因，带原因可设置和明确清空', async () => {
  const x = await fixture();
  const fields = { followUpOwner: '小林', followUpAt: '2026-10-06T09:00+08:00' };
  const missing = await x.call('cpm_report', { reportId: 'no-reason', fields });
  expect((missing.structuredContent as { result: Result }).result.warnings.join()).toContain('未写原因');
  expect(x.card()).toMatchObject({ followUpOwner: '我', followUpAt: null });
  expect((await x.call('cpm_report', { reportId: 'with-reasons', fields, reasons: { followUpOwner: '用户已指定跟进人', followUpAt: '等待对方在该时间提供材料' } })).isError).not.toBe(true);
  expect(x.card()).toMatchObject(fields);
  expect(x.card().fieldRevisions.followUpOwner).toMatchObject({ actor: { kind: 'session', id: 'issuer' }, reason: '用户已指定跟进人' });
  expect((await x.call('cpm_report', { reportId: 'clear', fields: { followUpOwner: '', followUpAt: null }, reason: '用户取消该次跟进安排' })).isError).not.toBe(true);
  expect(x.card()).toMatchObject({ followUpOwner: '', followUpAt: null });
});

test('C-426 MCP跟进报告保留人工修改优先与双会话冲突，不覆盖既有值', async () => {
  const x = await fixture();
  x.apply('card.update', { fields: { followUpOwner: '用户最新指定' } }, { actor: { kind: 'user' }, cardId: 'bound' });
  const protectedResult = await x.call('cpm_report', { reportId: 'respect-user', fields: { followUpOwner: 'AI旧理解' }, reason: '旧上下文' });
  expect(x.card().followUpOwner).toBe('用户最新指定');
  expect((protectedResult.structuredContent as { result: Result }).result.warnings.join()).toContain('以用户修改为准');
  const y = await fixture();
  y.apply('session.upsert', { id: 'collaborator', projectId: 'P', name: '合成协作会话' });
  y.apply('session.bind', {}, { actor: { kind: 'user' }, sessionId: 'collaborator', cardId: 'bound' });
  y.apply('turn.start', {}, { sessionId: 'collaborator', turnId: 'collaborator-turn' });
  expect((await y.call('cpm_report', { reportId: 'first-writer', fields: { followUpOwner: '第一人' }, reason: '第一份确认' })).isError).not.toBe(true);
  await y.call('cpm_report', { reportId: 'second-writer', fields: { followUpOwner: '第二人' }, reason: '另一份理解' }, 'collaborator');
  expect(y.card().followUpOwner).toBe('第一人');
  expect(y.card().conflicts).toContainEqual(expect.objectContaining({ field: 'followUpOwner', current: '第一人', proposed: '第二人', resolved: false }));
});

test('C-427 MCP报告非法跟进时间由core拒绝，不能伴随合法字段部分写入', async () => {
  const x = await fixture();
  const before = x.card();
  for (const followUpAt of ['2026-02-30T10:00+08:00', '2026-10-06T10:00', '', 123]) {
    expect((await x.call('cpm_report', { reportId: `bad-${String(followUpAt)}`, fields: { followUpOwner: '不能附带写入', followUpAt }, reason: '不能让无效时间生效' })).isError).toBe(true);
    expect(x.card()).toEqual(before);
  }
});

test('C-428 MCP快照支持两个行动视图、跟进人精确筛选及新字段排序', async () => {
  const x = await fixture();
  const add = (id: string, fields: Record<string, unknown>) => x.apply('card.create', { id, title: id, ...fields }, { actor: { kind: 'user' }, projectId: 'P' });
  add('today-later', { followUpOwner: 'A', followUpAt: '2026-10-06T23:00+08:00', dueDate: '2026-10-09' });
  add('follow-up-past', { followUpOwner: 'B', followUpAt: '2026-10-05T09:00+08:00' });
  add('delivery-overdue', { followUpOwner: 'C', followUpAt: '2026-10-07T09:00+08:00', dueDate: '2026-10-05' });
  add('delivery-today', { followUpOwner: 'D', dueDate: '2026-10-06' });
  const query = async (value: Record<string, unknown>) => {
    const response = await x.call('cpm_snapshot', { query: { projectIds: ['P'], now: '2026-10-06T00:30:00Z', ...value } });
    expect(response.isError).not.toBe(true);
    return (response.structuredContent as { query: QueryResult }).query.cards.map(card => card.id);
  };
  expect(await query({ view: '今天需跟进', sort: { field: 'followUpAt', direction: 'asc' } })).toEqual(['follow-up-past', 'today-later']);
  expect(await query({ view: '逾期事项' })).toEqual(['delivery-overdue']);
  expect(await query({ view: '全部', filters: [{ field: 'followUpOwner', condition: 'eq', value: 'A' }], sort: { field: 'followUpOwner', direction: 'asc' } })).toEqual(['today-later']);
  expect(await query({ view: '今天需跟进', sort: { field: 'followUpOwner', direction: 'desc' } })).toEqual(['follow-up-past', 'today-later']);
});

test('C-429 MCP报告计划中保留会话归属，AI报告完成仍为待验收且不勾验收', async () => {
  const x = await fixture();
  expect((await x.call('cpm_report', { reportId: 'plan', fields: { status: '计划中' }, reason: '需求已确认，正在制定执行计划' })).isError).not.toBe(true);
  expect(x.card().status).toBe('计划中');
  expect(x.card().fieldRevisions.status?.actor).toMatchObject({ kind: 'session', id: 'issuer' });
  expect((await x.call('cpm_report', { reportId: 'forged-user', fields: { status: '已完成' }, actor: { kind: 'user' } })).isError).toBe(true);
  expect(x.card().status).toBe('计划中');
  expect((await x.call('cpm_report', { reportId: 'finished-report', fields: { status: '已完成' }, reason: '产物完成，等待用户核验' })).isError).not.toBe(true);
  expect(x.card().status).toBe('待验收');
  expect(x.card().acceptance[0]?.checked).toBe(false);
});
