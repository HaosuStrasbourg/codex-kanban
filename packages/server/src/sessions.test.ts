import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer } from './server.ts';
import { HostMetadataError } from './host-metadata.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(ambiguous=false) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-session-tools-')));
  const store = new ProjectStore(join(dataDir, 'kanban.sqlite'));
  const htmlPath = join(dataDir, 'index.html'); writeFileSync(htmlPath, '<title>Synthetic</title>');
  store.applyEvent({ id: 'p', type: 'project.upsert', actor: {kind:'user'}, payload: {id:'P',name:'合成项目',folder:dataDir} });
  store.applyEvent({ id: 'c', type:'card.create', actor:{kind:'user'}, projectId:'P', payload:{id:'card',title:'合成卡片'} });
  const thread = { id:'target',name:'真实接口合成会话',projectId:'canonical',canonicalProjectId:'canonical',cwd:dataDir,
    createdAt:Math.floor(Date.now()/1000),updatedAt:Math.floor(Date.now()/1000),recencyAt:null,status:'idle',assignment:'canonical' };
  const reads: string[] = [];
  const hostMetadata = { list: async(folder:string,canonicalId?:string) => { reads.push(folder);
    if(ambiguous&&canonicalId!=='canonical')throw new HostMetadataError('PROJECT_AMBIGUOUS',[{id:'canonical',name:'所属项目'},{id:'shared',name:'共享目录的另一项目'}]);
    return {project:{id:'canonical',name:'合成项目',roots:[dataDir]},threads:[thread]}; },
    verify: async(folder:string,id:string) => { reads.push(folder); if(id!==thread.id) throw Error('not found');return thread; } };
  const prompts = new CurrentPromptStore(dataDir);
  const server = createKanbanServer({store,prompts,htmlPath,sessionId:'issuer',hostMetadata,dataDir} as any);
  const client = new Client({name:'synthetic-session-test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanup.push(async()=>{await client.close();await server.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const call = async(args:Record<string,unknown>,threadId='issuer') => client.callTool({name:'cpm_sessions',arguments:args,_meta:{threadId}});
  return {call,client,store,reads,dataDir};
}

test('会话工具声明只供App准备请求，模型仅能认领', async()=>{
  const {client}=await setup(); const {tools}=await client.listTools();
  expect(tools.find(t=>t.name==='cpm_sessions')?._meta?.ui).toEqual({visibility:['app']});
  expect(tools.find(t=>t.name==='cpm_claim')?._meta?.ui).toEqual({visibility:['model']});
});
test('会话列表仅按登记目录查询真实provider，经过core登记可绑定',async()=>{
  const {call,store,reads,dataDir}=await setup(); const r=await call({action:'list',projectId:'P'});
  expect(r.isError).not.toBe(true); expect(reads).toEqual([dataDir]);
  expect((r.structuredContent as any).sessions).toEqual([expect.objectContaining({id:'target',projectId:'P'})]);
  expect(store.getState().sessions[0]?.name).toBe('真实接口合成会话');
});
test('未登记项目和模型伪造会话身份不能读写桥接',async()=>{
  const {call,reads}=await setup();
  expect((await call({action:'list',projectId:'other'})).isError).toBe(true);
  expect((await call({action:'create',projectId:'P',cardId:'card',requestId:'r',issuerThreadId:'forged'})).isError).toBe(true);
  expect(reads).toEqual([]);
});
test('C-688 打开会话只返回经过真实同项目验证的目标，不生成聊天指令',async()=>{
  const {call}=await setup(); const r=await call({action:'open',projectId:'P',cardId:'card',sessionId:'target'});
  expect(r.isError).not.toBe(true);expect(r.structuredContent).toMatchObject({status:'ready',sessionId:'target'});
  expect(r.structuredContent).not.toHaveProperty('prompt');
  expect((await call({action:'open',projectId:'P',sessionId:'invented'})).isError).toBe(true);
});
test('创建先保持pending，新会话凭宿主身份认领后才绑定且重试幂等',async()=>{
  const {call,client,store}=await setup();
  const created=await call({action:'create',projectId:'P',cardId:'card',name:'新会话',requestId:'request-1'});
  expect(created.isError,JSON.stringify(created.structuredContent)).not.toBe(true);
  const data=created.structuredContent as any;
  expect(data.status).toBe('pending'); expect(store.getState().sessions).toHaveLength(0);
  const payload=JSON.parse(data.prompt.split('\n').at(-1));
  const claimArgs=JSON.parse(payload.prompt.match(/参数 (\{[^\n]+?\})。/)[1]);
  const forged=await client.callTool({name:'cpm_claim',arguments:{...claimArgs,threadId:'target'},_meta:{threadId:'issuer'}});
  expect(forged.isError).toBe(true);
  const self=await client.callTool({name:'cpm_claim',arguments:claimArgs,_meta:{threadId:'issuer'}});
  expect(self.isError).toBe(true);
  const claimed=await client.callTool({name:'cpm_claim',arguments:claimArgs,_meta:{threadId:'target'}});
  expect(claimed.isError).not.toBe(true);
  expect(store.getState().sessions[0]?.cardId).toBe('card');
  const revision=store.getState().revision;
  expect((await client.callTool({name:'cpm_claim',arguments:claimArgs,_meta:{threadId:'target'}})).isError).not.toBe(true);
  expect(store.getState().revision).toBe(revision);
  const status=await call({action:'status',requestId:'request-1'});
  expect(status.structuredContent).toMatchObject({status:'complete',sessionId:'target'});
  expect(JSON.stringify(status)).not.toContain(claimArgs.nonce);
  expect((await call({action:'status',requestId:'request-1'},'unrelated')).isError).toBe(true);
});
test('目录歧义明确交给用户选择，选择前无会话登记或创建票据',async()=>{
  const {call,client,store,dataDir}=await setup(true);
  const r=await call({action:'create',projectId:'P',cardId:'card',requestId:'ambiguous-request'});
  expect(r.isError).toBe(true);
  expect(r.structuredContent).toMatchObject({code:'PROJECT_AMBIGUOUS',projectCandidates:[{id:'canonical',name:'所属项目'},{id:'shared',name:'共享目录的另一项目'}]});
  expect(store.getState().sessions).toHaveLength(0);
  const snapshot=await client.callTool({name:'cpm_snapshot',arguments:{},_meta:{threadId:'issuer'}});
  expect((snapshot.structuredContent as {sessionRequests:unknown[]}).sessionRequests).toEqual([]);
  const mapping=await client.callTool({name:'cpm_apply',arguments:{event:{id:'mapping',type:'project.upsert',payload:{id:'P',name:'合成项目',folder:dataDir,hostProjectId:'canonical'}}}});
  expect(mapping.isError).not.toBe(true);
  expect((await call({action:'list',projectId:'P'})).isError).not.toBe(true);
});
test('用户明确放弃未认领请求后不能迟到认领，其他会话不能放弃',async()=>{
  const {call,client,store}=await setup();
  const created=await call({action:'create',projectId:'P',cardId:'card',requestId:'abandoned-request'});
  const data=created.structuredContent as any;
  const payload=JSON.parse(data.prompt.split('\n').at(-1));
  const claimArgs=JSON.parse(payload.prompt.match(/参数 (\{[^\n]+?\})。/)[1]);
  expect((await call({action:'abandon',requestId:'abandoned-request'},'other')).isError).toBe(true);
  expect((await call({action:'abandon',requestId:'abandoned-request'})).structuredContent).toMatchObject({ok:true,status:'abandoned'});
  expect((await call({action:'status',requestId:'abandoned-request'})).structuredContent).toMatchObject({status:'failed'});
  const late=await client.callTool({name:'cpm_claim',arguments:claimArgs,_meta:{threadId:'target'}});
  expect(late.isError).toBe(true);expect(store.getState().sessions).toHaveLength(0);
});

test('C-320 创建认领不能把已登记其他项目的未绑定会话移来或假称完成',async()=>{
  const {call,client,store,dataDir}=await setup();
  expect(store.applyEvent({id:'foreign-project',type:'project.upsert',actor:{kind:'user'},payload:{id:'Q',name:'明确归属项目',folder:`${dataDir}/other`}}).ok).toBe(true);
  expect(store.applyEvent({id:'foreign-session',type:'session.upsert',actor:{kind:'system'},payload:{id:'target',projectId:'Q',name:'已登记会话'}}).ok).toBe(true);
  const before=store.getState();
  const created=await call({action:'create',projectId:'P',cardId:'card',requestId:'foreign-claim'});
  expect(created.isError).not.toBe(true);
  const payload=JSON.parse((created.structuredContent as any).prompt.split('\n').at(-1));
  const claimArgs=JSON.parse(payload.prompt.match(/参数 (\{[^\n]+?\})。/)[1]);
  const claimed=await client.callTool({name:'cpm_claim',arguments:claimArgs,_meta:{threadId:'target'}});
  expect(claimed.isError).toBe(true);
  expect(store.getState()).toEqual(before);
  expect((await call({action:'status',requestId:'foreign-claim'})).structuredContent).not.toMatchObject({status:'complete'});
});

test('C-349 新会话bootstrap与成功认领要求范围受限的真实首次报告，不提前写业务报告',async()=>{
  const {call,client,store,dataDir}=await setup();
  writeFileSync(join(dataDir,'hook-scope.json'),JSON.stringify({mode:'bound-sessions',projectIds:['P']}),{mode:0o600});
  const created=await call({action:'create',projectId:'P',cardId:'card',requestId:'first-report'});
  const payload=JSON.parse((created.structuredContent as any).prompt.split('\n').at(-1));
  expect(payload.prompt).toContain('cpm_report');expect(payload.prompt).toContain('PreToolUse');
  expect(payload.prompt).toContain('不启动原任务');
  const claimArgs=JSON.parse(payload.prompt.match(/参数 (\{[^\n]+?\})。/)[1]);
  const claimed=await client.callTool({name:'cpm_claim',arguments:claimArgs,_meta:{threadId:'target'}});
  expect(claimed.isError).not.toBe(true);
  expect(claimed.structuredContent).toMatchObject({initialSync:{status:'required'},message:expect.stringContaining('cpm_report')});
  expect(store.getState().activities.some(activity=>activity.type==='report.submit')).toBe(false);
  expect(store.getState().sessions[0]?.turn).toBeUndefined();
});

test('C-355 新claim首次报告也固定原始创建票据，换绑后不能污染新卡',async()=>{
  const {call,client,store,dataDir}=await setup();
  writeFileSync(join(dataDir,'hook-scope.json'),JSON.stringify({mode:'bound-sessions',projectIds:['P']}),{mode:0o600});
  const created=await call({action:'create',projectId:'P',cardId:'card',requestId:'fixed-claim'});
  const payload=JSON.parse((created.structuredContent as any).prompt.split('\n').at(-1));
  const claimArgs=JSON.parse(payload.prompt.match(/参数 (\{[^\n]+?\})。/)[1]);
  const claimed=await client.callTool({name:'cpm_claim',arguments:claimArgs,_meta:{threadId:'target'}});
  const reportId=(claimed.structuredContent as any).message.match(/"reportId":"([^"]+)"/)[1];
  for(const event of [
    {id:'other-card',type:'card.create',actor:{kind:'user'},projectId:'P',payload:{id:'next',title:'新卡'}},
    {id:'rebind',type:'session.bind',actor:{kind:'user'},sessionId:'target',cardId:'next',payload:{confirmed:true}},
    {id:'actual-turn',type:'turn.start',actor:{kind:'system'},sessionId:'target',turnId:'actual',payload:{}},
  ] as const)expect(store.applyEvent(event).ok).toBe(true);
  const before=store.getState();
  const report=await client.callTool({name:'cpm_report',arguments:{reportId,fields:{progressText:'旧创建票据不能写新卡'}},_meta:{threadId:'target'}});
  expect(report.isError).toBe(true);expect(report.structuredContent).toMatchObject({message:expect.stringContaining('原授权')});
  expect(store.getState()).toEqual(before);
});
