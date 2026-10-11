import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import type { State } from '../../core/src/types.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer } from './server.ts';
import { createHostMetadataProvider, HostMetadataError, type HostMetadataChannel, type HostThreadAvailability } from './host-metadata.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-c131-audit-')));
  const store = new ProjectStore(':memory:');
  const folder = '/synthetic/C131-project';
  let archived = false;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const thread = () => ({ id: 'C131-main', name: '合成主会话', projectId: 'P', cwd: folder,
    createdAt: 123, updatedAt: 456, recencyAt: null, status: { type: 'idle' },
    parentThreadId: null, source: 'appServer',
    path: archived ? '/synthetic/codex/archived_sessions/thread.jsonl' : '/synthetic/codex/sessions/thread.jsonl' });
  const provider = createHostMetadataProvider({
    openChannel: (): HostMetadataChannel => ({
      async request(method, params) {
        requests.push({ method, params });
        if (method === 'project/list') return { data: [{ id: 'P', name: '合成项目', roots: [{ path: folder }] }], nextCursor: null };
        if (method === 'thread/read') return { thread: thread() };
        if (method === 'thread/list') return { data: archived ? [] : [thread()], nextCursor: null };
        return {};
      }, async initialized() {}, async close() {},
    }), verifyUnarchivedPath: async () => !archived, verifyArchivedPath: async () => archived,
  });
  for (const event of [
    { id: 'project', type: 'project.upsert' as const, actor: { kind: 'user' as const }, payload: { id: 'P', name: '合成项目', folder, hostProjectId: 'P' } },
    { id: 'card', type: 'card.create' as const, actor: { kind: 'user' as const }, projectId: 'P', payload: { id: 'C131-card', title: '隔离归档检查' } },
    { id: 'session', type: 'session.upsert' as const, actor: { kind: 'system' as const }, payload: { id: 'C131-main', name: '合成主会话', projectId: 'P', status: '空闲' } },
    { id: 'bind', type: 'session.bind' as const, actor: { kind: 'user' as const }, sessionId: 'C131-main', cardId: 'C131-card', payload: {} },
  ]) expect(store.applyEvent(event).ok).toBe(true);
  const htmlPath = join(directory, 'index.html'); writeFileSync(htmlPath, '<title>C131 isolated current-source audit</title>');
  const server = createKanbanServer({ store, prompts: new CurrentPromptStore(directory), htmlPath, hostMetadata: provider });
  const client = new Client({ name: 'C131-isolated-audit', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanup.push(async () => { await client.close(); await server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const snapshot = async (force = true) => {
    const result = await client.callTool({ name: 'cpm_snapshot', arguments: { refreshProjects: force }, _meta: { threadId: 'C131-main' } });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as unknown as { state: State };
  };
  return { store, provider, requests, snapshot, archive: () => { archived = true; }, unarchive: () => { archived = false; }, folder };
}

test('C-131 当前源码新MCP快照刷新后应识别官方已归档主会话并通知用户', async () => {
  const x = await fixture();
  const before = await x.snapshot();
  expect(before.state.cards[0]?.members[0]).toMatchObject({ role: '主会话', status: '空闲' });
  x.archive();
  // Establish the exact official read can detect the archive; no real host or
  // private conversation file participates in this fixture.
  await expect(x.provider.verify(x.folder, 'C131-main', 'P')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
  x.requests.splice(0);
  let after = before;
  for (let refresh = 0; refresh < 3; refresh++) after = await x.snapshot();
  const currentCard = after.state.cards.find(card => card.id === 'C131-card')!;
  expect(currentCard.flags, JSON.stringify({ observedMemberStatus: currentCard.members[0]?.status, refreshMethods: x.requests.map(request => request.method) })).toContain('主会话不可用');
  expect(after.state.notifications.filter(item => item.cardId === currentCard.id && item.type === '主会话不可用' && item.active)).toHaveLength(1);
});

test('C-131 正对照：已有核心session状态入口会生成不可用标记和需要我处理通知', async () => {
  const x = await fixture();
  const updated = x.store.applyEvent({ id: 'authoritative-archive', type: 'session.upsert', actor: { kind: 'system' },
    payload: { id: 'C131-main', projectId: 'P', name: '合成主会话', status: '已归档' } });
  expect(updated.ok).toBe(true);
  const state = x.store.getState();
  expect(state.cards[0]?.flags).toContain('主会话不可用');
  expect(state.notifications.filter(item => item.type === '主会话不可用' && item.active)).toHaveLength(1);
  expect(x.store.query({ view: '需要我处理' }).cards.map(card => card.id)).toContain('C131-card');
});

test('C-131 重复刷新归档状态不重复活动，恢复同ID只消除对应通知并保留回合与其他卡点', async () => {
  const x = await fixture();
  expect(x.store.applyEvent({ id: 'start', type: 'turn.start', actor: { kind: 'system' }, sessionId: 'C131-main', turnId: 'current-turn', payload: {} }).ok).toBe(true);
  expect(x.store.applyEvent({ id: 'blocker', type: 'checklist.add', actor: { kind: 'user' }, cardId: 'C131-card', payload: { list: 'blockers', content: '独立卡点', blocking: true, waitingFor: '我' } }).ok).toBe(true);
  x.archive(); const archived = await x.snapshot();
  expect(archived.state.sessions[0]).toMatchObject({ status: '已归档', turn: { id: 'current-turn' }, cardId: 'C131-card' });
  const before = x.store.getState(); await x.snapshot(); expect(x.store.getState()).toEqual(before);
  x.unarchive(); const recovered = await x.snapshot();
  expect(recovered.state.sessions[0]).toMatchObject({ status: '运行中', turn: { id: 'current-turn' }, cardId: 'C131-card' });
  expect(recovered.state.cards[0]?.flags).not.toContain('主会话不可用');
  expect(recovered.state.cards[0]?.flags).toContain('阻塞');
  expect(recovered.state.notifications.filter(item => item.type === '主会话不可用' && item.active)).toHaveLength(0);
  expect(recovered.state.notifications.filter(item => item.type === '卡点（等我处理）' && item.active)).toHaveLength(1);
});

test('C-131 元数据挂起仍快速显示已有看板且并发刷新单飞，不把失败或遗漏猜成删除', async () => {
  const x = await fixture();
  await x.snapshot();
  const before = x.store.getState();
  let reject!: (error: unknown) => void;
  const availability = vi.fn(() => new Promise<HostThreadAvailability>((_resolve, fail) => { reject = fail; }));
  x.provider.availability = availability;
  const start = performance.now(); await x.snapshot();
  expect(performance.now() - start).toBeLessThan(1000);
  await x.snapshot(); expect(availability).toHaveBeenCalledOnce();
  expect(x.store.getState()).toEqual(before);
  reject(new HostMetadataError('STEP_TIMEOUT')); await new Promise(resolve => setTimeout(resolve, 0));
  await x.snapshot(false); expect(x.store.getState()).toEqual(before);
  x.provider.availability = async () => { throw new HostMetadataError('THREAD_NOT_FOUND'); };
  await x.snapshot(); expect(x.store.getState()).toEqual(before);
});

test('C-131 延迟核验不能把新回合或已解绑会话写回旧卡片', async () => {
  for (const change of ['new-turn', 'unbind'] as const) {
    const x = await fixture(); await x.snapshot();
    let resolve!: (value: HostThreadAvailability) => void;
    x.provider.availability = () => new Promise(done => { resolve = done; });
    const pending = x.snapshot(); await new Promise(done => setTimeout(done, 0));
    if (change === 'new-turn') expect(x.store.applyEvent({ id: 'new-turn', type: 'turn.start', actor: { kind: 'system' }, sessionId: 'C131-main', turnId: 'new-turn', payload: {} }).ok).toBe(true);
    else expect(x.store.applyEvent({ id: 'unbind', type: 'session.unbind', actor: { kind: 'user' }, sessionId: 'C131-main', payload: {} }).ok).toBe(true);
    const before = x.store.getState();
    resolve({ status: 'archived', threadId: 'C131-main' }); await pending;
    expect(x.store.getState()).toEqual(before);
  }
});
