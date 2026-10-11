import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import type { Event } from '../../core/src/types.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer } from './server.ts';
import type { HostThread } from './host-metadata.ts';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(projectIds?:string[]) {
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'cpm-bound-sync-')));
  const store=new ProjectStore(':memory:'); let seq=0;
  const apply=(type:Event['type'],payload:Record<string,unknown>,extra:Partial<Event>={})=>{
    const result=store.applyEvent({id:`setup-${++seq}`,type,actor:{kind:'system'},payload,...extra});
    expect(result.ok,result.errors.join()).toBe(true); return result;
  };
  apply('project.upsert',{id:'P',name:'合成项目',folder:directory});
  apply('card.create',{id:'card',title:'合成卡片'},{actor:{kind:'user'},projectId:'P'});
  apply('session.upsert',{id:'target',projectId:'P',name:'合成既有会话'});
  apply('session.bind',{},{actor:{kind:'user'},cardId:'card',sessionId:'target'});
  const thread:HostThread={id:'target',name:'合成既有会话',projectId:'canonical',canonicalProjectId:'canonical',cwd:directory,
    createdAt:1_700_000_000,updatedAt:1_700_000_000,recencyAt:null,status:'idle',assignment:'canonical'};
  let verifications=0;
  const hostMetadata={list:async()=>({project:{id:'canonical',name:'合成项目',roots:[directory]},threads:[thread]}),
    verify:async(folder:string,id:string)=>{verifications++;expect(folder).toBe(directory);expect(id).toBe('target');return {...thread};}};
  const scope=(ids:string[])=>writeFileSync(join(directory,'hook-scope.json'),JSON.stringify({mode:'bound-sessions',projectIds:ids}),{mode:0o600});
  if(projectIds)scope(projectIds);
  const htmlPath=join(directory,'index.html');writeFileSync(htmlPath,'<title>合成首次同步</title>');
  const prompts=new CurrentPromptStore(directory);
  const connections:{client:Client;server:ReturnType<typeof createKanbanServer>}[]=[];
  const connect=async()=>{
    const server=createKanbanServer({store,prompts,dataDir:directory,htmlPath,hostMetadata});
    const client=new Client({name:'synthetic-first-sync',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    connections.push({client,server});return client;
  };
  const client=await connect();
  cleanup.push(async()=>{for(const {client,server} of connections){await client.close();await server.close();}store.close();rmSync(directory,{recursive:true,force:true});});
  const args={action:'sync',projectId:'P',cardId:'card',sessionId:'target',requestId:'sync-1'};
  const call=(changes:Record<string,unknown>={},issuer='issuer',targetClient=client)=>targetClient.callTool({name:'cpm_sessions',arguments:{...args,...changes},...(issuer ? {_meta:{threadId:issuer}} : {})});
  return {store,apply,thread,client,connect,call,scope,prompts,args,directory,verifications:()=>verifications};
}

test('C-340 缺少或不匹配项目白名单返回disabled，不声称已连接且不写业务数据',async()=>{
  const x=await fixture();const before=x.store.getState();
  expect((await x.call()).structuredContent).toMatchObject({ok:true,action:'sync',status:'disabled',sessionId:'target',cardId:'card',requestId:'sync-1'});
  const snapshot=await x.client.callTool({name:'cpm_snapshot',arguments:{}});
  expect(snapshot.structuredContent).toMatchObject({capabilities:{automaticSync:{state:'disabled',configuredProjectIds:[]}}});
  x.scope(['other']);expect((await x.call()).structuredContent).toMatchObject({status:'disabled'});
  expect(x.verifications()).toBe(0);expect(x.store.getState()).toEqual(before);
});

test('C-341 有效旧会话首次同步只提供官方准确目标指令，范围限定且无业务改动',async()=>{
  const x=await fixture(['P']);const before=x.store.getState();
  const response=await x.call();expect(response.isError).not.toBe(true);
  const data=response.structuredContent as {status:string;prompt:string};
  expect(data.status).toBe('dispatch');expect(data.prompt).toContain('send_message_to_thread');
  const target=JSON.parse(data.prompt.split('\n').at(-1)!);
  expect(target.threadId).toBe('target');
  expect(target.prompt).toContain('plugin://codex-pm@codex-kanban');
  for(const text of ['cpm_report','当前上下文','实际进展','下一步','卡点','不启动原任务','不扫描全文','不确认完成或验收'])expect(target.prompt).toContain(text);
  expect(target.prompt).toContain('status');
  expect(x.store.getState()).toEqual(before);expect(x.verifications()).toBe(1);
  const snapshot=await x.client.callTool({name:'cpm_snapshot',arguments:{}});
  expect(snapshot.structuredContent).toMatchObject({capabilities:{automaticSync:{state:'configured',configuredProjectIds:['P']}}});
  expect((snapshot.structuredContent as any).capabilities.automaticSync.message).not.toMatch(/已连接|已接通/);
});

test('C-342 同请求并发与新进程实例读取都不重发，真实匹配报告后才complete',async()=>{
  const x=await fixture(['P']);
  const results=await Promise.all([x.call(),x.call()]);
  expect(results.map(r=>(r.structuredContent as any)?.status).sort()).toEqual(['dispatch','pending']);
  const dispatched=results.find(r=>(r.structuredContent as any)?.status==='dispatch')!.structuredContent as any;
  const reportId=JSON.parse(dispatched.prompt.split('\n').at(-1)).prompt.match(/"reportId":"([^"]+)"/)[1];
  const another=await x.connect();
  const repeated=await x.call({},'issuer',another);
  expect(repeated.structuredContent).toMatchObject({status:'pending'});expect(repeated.structuredContent).not.toHaveProperty('prompt');
  const before=x.store.getState();
  expect((await x.call({},'different-issuer')).isError).toBe(true);expect(x.store.getState()).toEqual(before);
  x.apply('turn.start',{},{sessionId:'target',turnId:'actual-turn'});
  const report=await x.client.callTool({name:'cpm_report',arguments:{reportId,fields:{progressText:'实际已有进展',nextStep:'待用户新指令'}},_meta:{threadId:'target'}});
  expect(report.isError).not.toBe(true);
  expect((await x.call()).structuredContent).toMatchObject({status:'complete'});
});

test.each(['turn','pending-rebind','host-active'])('C-343 %s先deferred且不占用请求，空闲且绑定生效后才dispatch',async kind=>{
  const x=await fixture(['P']);
  // This case covers a genuinely running host; idle with a lost Stop is C-553.
  x.thread.status='active';
  if(kind!=='host-active') {
    x.apply('turn.start',{},{sessionId:'target',turnId:'running'});
    if(kind==='pending-rebind'){
      x.apply('card.create',{id:'card-next',title:'下一张卡'},{actor:{kind:'user'},projectId:'P'});
      x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'target',cardId:'card-next'});
    }
  }
  const changes=kind==='pending-rebind'?{cardId:'card-next'}:{};
  const before=x.store.getState();
  expect((await x.call(changes)).structuredContent).toMatchObject({status:'deferred'});
  expect(x.store.getState()).toEqual(before);
  x.thread.status='idle';if(kind!=='host-active')x.apply('turn.end',{},{sessionId:'target',turnId:'running'});
  expect((await x.call(changes)).structuredContent).toMatchObject({status:'dispatch'});
});

test('C-344 目标是当前issuer时只要求直接报告，不递归给自己发消息',async()=>{
  const x=await fixture(['P']);const response=await x.call({},'target');
  expect(response.structuredContent).toMatchObject({status:'dispatch'});
  const prompt=(response.structuredContent as any).prompt;
  expect(prompt).toContain('本轮');expect(prompt).toContain('cpm_report');expect(prompt).not.toContain('send_message_to_thread');
});

test('C-345 未绑定、错误目标metadata和缺失宿主身份均拒绝，不产生报告',async()=>{
  const x=await fixture(['P']);const before=x.store.getState();
  expect((await x.call({},'')).isError).toBe(true);
  x.thread.id='foreign';expect((await x.call()).isError).toBe(true);x.thread.id='target';
  x.apply('session.unbind',{},{actor:{kind:'user'},sessionId:'target'});
  expect((await x.call()).isError).toBe(true);
  expect(x.store.getState().activities.filter(a=>a.type==='report.submit')).toHaveLength(0);
  expect(x.store.getState().cards[0]?.progressText).toBe(before.cards[0]?.progressText);
});

test('C-346 正式入口即使有宿主身份与当前原文也拒绝对话验收及对话绑定',async()=>{
  const x=await fixture(['P']);x.apply('turn.start',{},{sessionId:'target',turnId:'actual'});
  x.prompts.record({sessionId:'target',turnId:'actual',text:'这个算完成了'});
  const before=x.store.getState();
  const instruction=await x.client.callTool({name:'cpm_instruction',arguments:{quote:'这个算完成了',action:'complete'},_meta:{threadId:'target'}});
  expect(instruction.isError).toBe(true);expect(instruction.structuredContent).toMatchObject({message:expect.stringContaining('生产')});
  x.prompts.record({sessionId:'target',turnId:'actual',text:'绑定到 #1'});
  const bind=await x.client.callTool({name:'cpm_bind',arguments:{cardNo:1},_meta:{threadId:'target'}});
  expect(bind.isError).toBe(true);expect(bind.structuredContent).toMatchObject({message:expect.stringContaining('生产')});
  expect(x.store.getState()).toEqual(before);
});

test.each(['damaged','public'])('C-347 派发记录%s时拒绝重发，保留业务状态',async kind=>{
  const x=await fixture(['P']);expect((await x.call()).structuredContent).toMatchObject({status:'dispatch'});
  const before=x.store.getState();const directory=join(x.directory,'sync-requests');
  const file=join(directory,readdirSync(directory)[0]!);
  if(kind==='damaged')writeFileSync(file,'{partial');else chmodSync(file,0o644);
  const retry=await x.call();expect(retry.isError).toBe(true);
  expect(retry.structuredContent).not.toHaveProperty('prompt');
  expect(retry.structuredContent).toMatchObject({message:expect.stringContaining('结果未知')});
  expect(x.store.getState()).toEqual(before);
});

test('C-348 缺scope不消耗请求，用户配置后同ID可派发；其他报告不得误判首次同步完成',async()=>{
  const x=await fixture();expect((await x.call()).structuredContent).toMatchObject({status:'disabled'});
  x.scope(['P']);expect((await x.call()).structuredContent).toMatchObject({status:'dispatch'});
  x.apply('turn.start',{},{sessionId:'target',turnId:'unrelated'});
  const report=await x.client.callTool({name:'cpm_report',arguments:{reportId:'unrelated',noChange:true},_meta:{threadId:'target'}});
  expect(report.isError).not.toBe(true);
  const followup=await x.call();expect(followup.structuredContent).toMatchObject({status:'pending'});expect(followup.structuredContent).not.toHaveProperty('prompt');
});

test.each([undefined,'card-next'])('C-355 首次派发后换绑不能用旧reportId写新卡或篡改expectedCardId绕过：%s',async expectedCardId=>{
  const x=await fixture(['P']);const dispatch=await x.call();
  const prompt=JSON.parse((dispatch.structuredContent as any).prompt.split('\n').at(-1)).prompt;
  const reportId=prompt.match(/"reportId":"([^"]+)"/)[1];
  x.apply('card.create',{id:'card-next',title:'不可污染的新卡'},{actor:{kind:'user'},projectId:'P'});
  x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'target',cardId:'card-next'});
  x.apply('turn.start',{},{sessionId:'target',turnId:'new-card-turn'});
  const before=x.store.getState();
  const response=await x.client.callTool({name:'cpm_report',arguments:{reportId,...(expectedCardId?{expectedCardId}:{}),fields:{progressText:'原卡首次报告不得写新卡'}},_meta:{threadId:'target'}});
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({message:expect.stringContaining('原授权')});
  expect(x.store.getState()).toEqual(before);
});

test('C-356 本地旧运行中状态没有turn且宿主idle时可派发，不伪造回合',async()=>{
  const x=await fixture(['P']);x.apply('session.upsert',{id:'target',projectId:'P',name:'旧状态',status:'运行中'});
  const before=x.store.getState();expect((await x.call()).structuredContent).toMatchObject({status:'dispatch'});
  expect(x.store.getState()).toEqual(before);
});

test('C-356 孤立pending换绑缺少turn时明确提示解绑重关联，不永久deferred或制造turn',async()=>{
  const x=await fixture(['P']);x.apply('session.upsert',{id:'target',projectId:'P',name:'旧状态',status:'运行中'});
  x.apply('card.create',{id:'card-next',title:'待生效卡'},{actor:{kind:'user'},projectId:'P'});
  x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'target',cardId:'card-next'});
  const before=x.store.getState();const response=await x.call({cardId:'card-next'});
  expect(response.isError).toBe(true);expect(response.structuredContent).toMatchObject({message:expect.stringContaining('先解绑')});
  expect(x.store.getState()).toEqual(before);
  x.apply('session.unbind',{},{actor:{kind:'user'},sessionId:'target'});
  x.apply('session.bind',{},{actor:{kind:'user'},sessionId:'target',cardId:'card-next'});
  expect((await x.call({cardId:'card-next'})).structuredContent).toMatchObject({status:'dispatch'});
  expect(x.store.getState().sessions[0]?.turn).toBeUndefined();
});
