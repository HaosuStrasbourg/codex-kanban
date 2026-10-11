import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer } from './server.ts';
import { HostMetadataError, type HostMetadataProvider, type HostProject } from './host-metadata.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(hostMetadata: HostMetadataProvider) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-project-discovery-')));
  const store = new ProjectStore(':memory:');
  const htmlPath = join(directory, 'index.html'); writeFileSync(htmlPath, '<title>isolated project discovery</title>');
  const server = createKanbanServer({ store, prompts: new CurrentPromptStore(directory), htmlPath, hostMetadata });
  const client = new Client({ name: 'isolated-discovery', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (name: string, args: Record<string, unknown> = {}, threadId?: string) => client.callTool({ name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) });
  return { store, client, call };
}
const base: HostMetadataProvider = { list: async () => { throw new HostMetadataError('UNSUPPORTED'); }, verify: async () => { throw new HostMetadataError('UNSUPPORTED'); } };
const p: HostProject = { id: 'host-P', name: '项目P', roots: ['/synthetic/P'] };
const q: HostProject = { id: 'host-Q', name: '项目Q', roots: ['/synthetic/Q'] };

test('C-650 来源新增Q后自动出现且保留P，重复刷新不创建卡片会话或重复活动', async () => {
  let projects = [p];
  const x = await fixture({ ...base, projects: async () => projects });
  await x.call('cpm_snapshot');
  expect(x.store.getState().projects).toMatchObject([{ id: p.id, name: p.name, folder: p.roots[0], hostProjectId: p.id }]);
  projects = [p, q];
  await x.call('cpm_snapshot', { refreshProjects: true });
  const before = x.store.getState();
  expect(before.projects.map(item => [item.id, item.name, item.folder])).toEqual([[p.id, p.name, p.roots[0]], [q.id, q.name, q.roots[0]]]);
  await x.call('cpm_snapshot', { refreshProjects: true });
  expect(x.store.getState()).toEqual(before);
  expect(before.cards).toEqual([]); expect(before.sessions).toEqual([]);
  expect(before.activities.every(item => item.actor.kind === 'system')).toBe(true);
});

test('C-650 宿主项目读取挂起不阻断首次看板，同一来源刷新单飞且失败保留已有数据', async () => {
  let reject!: (error: unknown) => void;
  const projects = vi.fn(() => new Promise<HostProject[]>((_resolve, fail) => { reject = fail; }));
  const x = await fixture({ ...base, projects });
  const start = performance.now();
  const first = await x.call('cpm_snapshot');
  expect(performance.now() - start).toBeLessThan(1000);
  expect((first.structuredContent as any).projectDiscovery.status).toBe('refreshing');
  await x.call('cpm_snapshot', { refreshProjects: true });
  expect(projects).toHaveBeenCalledOnce();
  reject(new HostMetadataError('HOST_UNAVAILABLE'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const response = await x.call('cpm_snapshot');
  expect((response.structuredContent as any).projectDiscovery.status).toBe('unavailable');
  expect(x.store.getState().projects).toEqual([]);
});

test('C-650 同目录的既有手工项目复用，官方刷新不能劫持另一个映射', async () => {
  const x = await fixture({ ...base, projects: async () => [p, q] });
  x.store.applyEvent({ id: 'manual', type: 'project.upsert', actor: { kind: 'user' }, payload: { id: 'local-P', name: '旧P', folder: p.roots[0] } });
  await x.call('cpm_snapshot');
  expect(x.store.getState().projects.filter(item => item.folder === p.roots[0])).toMatchObject([{ id: 'local-P', name: p.name }]);
  expect(x.store.getState().projects).toHaveLength(2);
  const rejected = x.store.applyEvent({ id: 'hijack', type: 'project.upsert', actor: { kind: 'system' }, payload: { id: 'local-P', name: '劫持', folder: p.roots[0], hostProjectId: q.id } });
  expect(rejected.ok).toBe(false);
  expect(x.store.getState().projects.find(item => item.id === 'local-P')?.hostProjectId).toBeUndefined();
});

test('C-650 新多根项目不猜第一目录且不阻断其他项目，明确登记根目录后可同步', async () => {
  const multi = { id: 'multi', name: '多根项目', roots: ['/synthetic/first', '/synthetic/second'] };
  const x = await fixture({ ...base, projects: async () => [multi, p] });
  const response = await x.call('cpm_snapshot');
  expect(x.store.getState().projects.map(item => item.id)).toEqual([p.id]);
  expect((response.structuredContent as any).projectDiscovery).toMatchObject({ status: 'available', message: expect.stringContaining('多个根目录') });
  x.store.applyEvent({ id: 'choose-root', type: 'project.upsert', actor: { kind: 'user' }, payload: { id: 'selected', name: '手工选择', folder: multi.roots[1] } });
  await x.call('cpm_snapshot', { refreshProjects: true });
  expect(x.store.getState().projects.find(item => item.id === 'selected')).toMatchObject({ name: multi.name, folder: multi.roots[1] });
  expect(x.store.getState().projects).toHaveLength(2);
});

test('C-651 项目来源不可用时准确目录首次建A再建B仅登记一次，无额外手工步骤', async () => {
  const current = vi.fn(async (threadId: string) => ({ threadId, folder: '/synthetic/exact-folder', hostProjectId: null }));
  const x = await fixture({ ...base, projects: async () => { throw new HostMetadataError('UNSUPPORTED'); }, current });
  const snapshot = await x.call('cpm_snapshot', {}, 'issuer');
  expect((snapshot.structuredContent as any).projectDiscovery).toMatchObject({ status: 'unavailable', currentFolder: '/synthetic/exact-folder' });
  expect(x.store.getState().projects).toEqual([]);
  for (const title of ['A', 'B']) expect((await x.call('cpm_apply', { event: { id: `create-${title}`, type: 'card.create', payload: { title } } }, 'issuer')).isError).not.toBe(true);
  const state = x.store.getState();
  expect(state.projects).toHaveLength(1); expect(state.projects[0]?.folder).toBe('/synthetic/exact-folder');
  expect(state.cards.map(item => [item.title, item.projectId])).toEqual([['A', state.projects[0]!.id], ['B', state.projects[0]!.id]]);
  expect(state.sessions).toEqual([]);
  expect(current).toHaveBeenCalledWith('issuer');
  const before = x.store.getState();
  current.mockRejectedValue(new HostMetadataError('HOST_UNAVAILABLE'));
  await x.call('cpm_apply', { event: { id: 'create-A', type: 'card.create', payload: { title: 'A' } } }, 'issuer');
  expect(x.store.getState()).toEqual(before);
});

test('C-651 缺身份或目录不明不按名称父目录猜项目，也不创建卡片', async () => {
  const x = await fixture({ ...base, projects: async () => { throw new HostMetadataError('UNSUPPORTED'); }, current: async () => { throw new HostMetadataError('THREAD_NOT_FOUND'); } });
  for (const threadId of [undefined, 'unknown']) {
    const before = x.store.getState();
    const result = await x.call('cpm_apply', { event: { id: `create-${threadId}`, type: 'card.create', payload: { title: '不能猜' } } }, threadId);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/目录|项目|核验/);
    expect(x.store.getState()).toEqual(before);
  }
});

test('C-651 提交时重新核验目录，不信任客户端填入目录或过期快照', async () => {
  let folder = '/synthetic/before';
  const x = await fixture({ ...base, projects: async () => { throw new HostMetadataError('UNSUPPORTED'); }, current: async threadId => ({ threadId, folder, hostProjectId: null }) });
  await x.call('cpm_snapshot', {}, 'issuer'); folder = '/synthetic/after';
  const response = await x.call('cpm_apply', { event: { id: 'create-fresh', type: 'card.create', payload: { title: 'Fresh' } } }, 'issuer');
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response)).toContain('目录已变化');
  expect(x.store.getState().projects).toEqual([]);
  const forged = await x.call('cpm_apply', { event: { id: 'forged', type: 'card.create', folder: '/synthetic/forged', payload: { title: 'forged' } } }, 'issuer');
  expect(forged.isError).toBe(true); expect(x.store.getState().cards).toHaveLength(0);
});

test('C-651 首次无快照建卡并行读取准确目录与项目来源，两个慢请求不叠加', async () => {
  let finishCurrent!: (value: { threadId: string; folder: string; hostProjectId: null }) => void;
  let failProjects!: (error: unknown) => void;
  const current = vi.fn(() => new Promise<{ threadId: string; folder: string; hostProjectId: null }>(resolve => { finishCurrent = resolve; }));
  const projects = vi.fn(() => new Promise<HostProject[]>((_resolve, reject) => { failProjects = reject; }));
  const x = await fixture({ ...base, current, projects });
  const creating = x.call('cpm_apply', { event: { id: 'first-slow', type: 'card.create', payload: { title: 'slow A' } } }, 'issuer');
  await new Promise(resolve => setTimeout(resolve, 10));
  const bothStarted = current.mock.calls.length === 1 && projects.mock.calls.length === 1;
  finishCurrent({ threadId: 'issuer', folder: '/synthetic/slow-folder', hostProjectId: null });
  await new Promise(resolve => setTimeout(resolve, 0));
  failProjects(new HostMetadataError('UNSUPPORTED'));
  const response = await creating;
  expect(bothStarted).toBe(true);
  expect(response.isError).not.toBe(true);
  expect(x.store.getState().cards).toHaveLength(1);
  expect(x.store.getState().projects[0]?.folder).toBe('/synthetic/slow-folder');
});
