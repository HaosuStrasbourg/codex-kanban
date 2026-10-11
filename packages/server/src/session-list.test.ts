import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import type { Event } from '../../core/src/types.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer } from './server.ts';
import { HostMetadataError, type HostThread } from './host-metadata.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-project-sessions-')));
  const store = new ProjectStore(':memory:');
  let sequence = 0;
  const apply = (type: Event['type'], payload: Record<string, unknown>, extra: Partial<Event> = {}) => {
    const applied = store.applyEvent({ id: `fixture-${++sequence}`, type, actor: {kind:'system'}, payload, ...extra });
    expect(applied.ok, applied.errors.join()).toBe(true); return applied;
  };
  apply('project.upsert', {id:'P',name:'合成项目',folder:directory});
  apply('project.upsert', {id:'Q',name:'其他项目',folder:`${directory}/other`});
  const historical = 1_700_000_000;
  const thread: HostThread = {id:'historical',name:'合成历史会话',projectId:'canonical',canonicalProjectId:'canonical',cwd:directory,
    createdAt:historical,updatedAt:historical,recencyAt:null,status:'idle',assignment:'canonical'};
  let listed = [thread], ambiguous = false, reads = 0;
  const hostMetadata = {
    list: async (folder: string) => {
      reads++; expect(folder).toBe(directory);
      if (ambiguous) throw new HostMetadataError('PROJECT_AMBIGUOUS', [{id:'canonical',name:'所属项目'},{id:'shared',name:'同目录其他项目'}]);
      return {project:{id:'canonical',name:'合成项目',roots:[directory]},threads:listed};
    },
    verify: async () => { reads++; return thread; },
  };
  const htmlPath = join(directory, 'index.html'); writeFileSync(htmlPath, '<title>合成列表</title>');
  const server = createKanbanServer({store,hostMetadata,dataDir:directory,htmlPath,prompts:new CurrentPromptStore(directory)});
  const client = new Client({name:'project-session-list-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanup.push(async()=>{await client.close();await server.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const call = (args: Record<string, unknown>, identity?: string) => client.callTool({name:'cpm_sessions',arguments:args,...(identity ? {_meta:{threadId:identity}} : {})});
  return {store,apply,thread,call,historical,reads:()=>reads,setListed:(threads:HostThread[])=>{listed=threads;},setAmbiguous:()=>{ambiguous=true;}};
}

test('C-311 全局看板无关联会话身份仍可读取明确登记项目，历史会话不自动建卡', async () => {
  const x = await fixture();
  const result = await x.call({action:'list',projectId:'P'});
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ok:true,action:'list',sessions:[{id:'historical',projectId:'P',name:'合成历史会话',lastActivityAt:new Date(x.historical*1000).toISOString()}]});
  expect(x.store.getState().cards).toEqual([]);
  expect(x.store.getState().sessions[0]?.cardId).toBeUndefined();
  expect(x.reads()).toBe(1);
});

test('C-312 新列表不吞掉本项目已有会话，不把缺席视为删除，其他项目不混入', async () => {
  const x = await fixture();
  x.apply('session.upsert',{id:'known',projectId:'P',name:'已登记',status:'空闲'});
  x.apply('session.upsert',{id:'foreign',projectId:'Q',name:'其他项目'});
  const before = x.store.getState().sessions.find(s=>s.id==='known');
  const result = await x.call({action:'list',projectId:'P'}, 'issuer');
  expect(result.isError).not.toBe(true);
  expect((result.structuredContent as {sessions:{id:string}[]}).sessions.map(s=>s.id).sort()).toEqual(['historical','known']);
  expect(x.store.getState().sessions.find(s=>s.id==='known')).toEqual(before);
  x.setListed([]);
  const emptyListing = await x.call({action:'list',projectId:'P'}, 'issuer');
  expect((emptyListing.structuredContent as {sessions:{id:string}[]}).sessions.map(s=>s.id).sort()).toEqual(['historical','known']);
  expect(x.store.getState().cards).toEqual([]);
});

test('C-313 名称不变但官方时间变化也同步，重复刷新不添加活动', async () => {
  const x = await fixture();
  await x.call({action:'list',projectId:'P'}, 'issuer');
  const original = x.store.getState();
  x.thread.updatedAt += 3600;
  const result = await x.call({action:'list',projectId:'P'}, 'issuer');
  expect(result.isError).not.toBe(true);
  const changed = x.store.getState();
  expect(changed.sessions[0]?.lastActivityAt).toBe(new Date(x.thread.updatedAt*1000).toISOString());
  expect(changed.activities).toHaveLength(original.activities.length+1);
  expect(changed.activities.at(-1)?.at).not.toBe(changed.sessions[0]?.lastActivityAt);
  await x.call({action:'list',projectId:'P'}, 'issuer');
  expect(x.store.getState()).toEqual(changed);
});

test('C-314 列表同步最近活动时间及名称，保留更晚Hook时间、绑定、回合与业务状态', async () => {
  const x = await fixture(); x.thread.recencyAt = x.thread.updatedAt + 7200;
  await x.call({action:'list',projectId:'P'}, 'issuer');
  expect(x.store.getState().sessions[0]?.lastActivityAt).toBe(new Date(x.thread.recencyAt*1000).toISOString());
  x.apply('card.create',{id:'card',title:'工作卡'},{actor:{kind:'user'},projectId:'P'});
  x.apply('session.bind',{},{actor:{kind:'user'},sessionId:x.thread.id,cardId:'card'});
  x.apply('turn.start',{},{sessionId:x.thread.id,turnId:'current-turn',at:'2026-10-05T12:00:00.000Z'});
  const before = x.store.getState().sessions[0]!;
  x.thread.name = '官方新名称'; x.thread.status = 'idle';
  await x.call({action:'list',projectId:'P'}, 'issuer');
  expect(x.store.getState().sessions[0]).toEqual({...before,name:'官方新名称'});
  expect(x.store.getState().cards[0]?.status).toBe('未开始');
  const stable = x.store.getState();
  await x.call({action:'list',projectId:'P'}, 'issuer');
  expect(x.store.getState()).toEqual(stable);
});

test.each(['create','open','status','abandon'])('C-315 %s继续拒绝缺少宿主身份，不读metadata或产生请求', async action => {
  const x = await fixture(); const before = x.store.getState();
  const result = await x.call({action,projectId:'P',cardId:'card',sessionId:'historical',requestId:'request'});
  expect(result.isError).toBe(true); expect(x.reads()).toBe(0);
  expect(x.store.getState()).toEqual(before);
});

test('C-316 全局列表仍拒绝未登记项目并明确返回PROJECT_AMBIGUOUS，不猜归属', async () => {
  const x = await fixture(); const before = x.store.getState();
  expect((await x.call({action:'list',projectId:'unknown'})).isError).toBe(true); expect(x.reads()).toBe(0);
  x.setAmbiguous();
  const ambiguous = await x.call({action:'list',projectId:'P'});
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.structuredContent).toMatchObject({code:'PROJECT_AMBIGUOUS',projectCandidates:[{id:'canonical',name:'所属项目'},{id:'shared',name:'同目录其他项目'}]});
  expect(x.store.getState()).toEqual(before);
});

test.each([false,true])('C-320 刷新跳过已登记其他项目的会话（已绑定=%s），保留归属且继续同步本项目', async bound => {
  const x = await fixture();
  x.apply('session.upsert',{id:x.thread.id,projectId:'Q',name:'明确属于其他项目'});
  if (bound) {
    x.apply('card.create',{id:'foreign-card',title:'其他项目工作卡'},{actor:{kind:'user'},projectId:'Q'});
    x.apply('session.bind',{},{actor:{kind:'user'},sessionId:x.thread.id,cardId:'foreign-card'});
  }
  const before = x.store.getState();
  x.setListed([x.thread,{...x.thread,id:'local',name:'本项目会话'}]);
  const result = await x.call({action:'list',projectId:'P'});
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ok:true,sessions:[{id:'local',projectId:'P'}],warnings:[expect.stringContaining('已登记在其他项目')]});
  expect(x.store.getState().sessions.find(s=>s.id===x.thread.id)).toEqual(before.sessions[0]);
  expect(x.store.getState().cards).toEqual(before.cards);
  expect(x.store.getState().activities.slice(before.activities.length)).toHaveLength(1);
  const stable = x.store.getState();
  await x.call({action:'list',projectId:'P'});
  expect(x.store.getState()).toEqual(stable);
});
