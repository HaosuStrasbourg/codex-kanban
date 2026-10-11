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

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(options:{registered?:boolean;host?:boolean;ambiguous?:boolean}={}) {
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'cpm-assistant-tools-'))),store=new ProjectStore(':memory:');let seq=0;
  const apply=(type:Event['type'],payload:Record<string,unknown>,extra:Partial<Event>={})=>{const value=store.applyEvent({id:`setup-${++seq}`,type,actor:{kind:'system'},payload,...extra});expect(value.ok,value.errors.join()).toBe(true);return value;};
  apply('project.upsert',{id:'P',name:'合成项目',folder:directory});apply('project.upsert',{id:'Q',name:'其他项目',folder:`${directory}/other`});
  for(const id of ['card','second'])apply('card.create',{id,title:id},{actor:{kind:'user'},projectId:'P'});
  if(options.registered!==false)apply('session.upsert',{id:'issuer',projectId:'P',name:'发起会话'});
  apply('session.upsert',{id:'foreign',projectId:'Q',name:'其他项目会话'});
  const thread=(id:string,project='P'):HostThread=>({id,name:`合成-${id}`,projectId:`host-${project}`,canonicalProjectId:`host-${project}`,cwd:project==='P'?directory:`${directory}/other`,createdAt:Math.floor(Date.now()/1000),updatedAt:Math.floor(Date.now()/1000),recencyAt:null,status:'idle',assignment:'canonical'});
  const threads=new Map([['issuer',thread('issuer')],['target',thread('target')],['new',thread('new')],['foreign',thread('foreign','Q')]]);
  const reads:string[]=[];
  const hostMetadata={list:async(folder:string)=>{reads.push(folder);if(options.ambiguous)throw new HostMetadataError('PROJECT_AMBIGUOUS',[{id:'one',name:'一'},{id:'two',name:'二'}]);return{project:{id:'host-P',name:'合成项目',roots:[directory]},threads:[...threads.values()].filter(t=>t.cwd===folder)};},
    verify:async(folder:string,id:string)=>{reads.push(id);if(options.ambiguous)throw new HostMetadataError('PROJECT_AMBIGUOUS',[{id:'one',name:'一'},{id:'two',name:'二'}]);const found=threads.get(id);if(!found||found.cwd!==folder)throw new HostMetadataError('THREAD_NOT_FOUND');return found;}};
  writeFileSync(join(directory,'hook-scope.json'),JSON.stringify({mode:'bound-sessions',projectIds:['P']}),{mode:0o600});
  const htmlPath=join(directory,'index.html');writeFileSync(htmlPath,'<title>合成AI代办</title>');
  const server=createKanbanServer({store,prompts:new CurrentPromptStore(directory),dataDir:directory,htmlPath,...(options.host===false?{}:{hostMetadata})});
  const client=new Client({name:'assistant-channel-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  cleanup.push(async()=>{await client.close();await server.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const call=(name:string,args:Record<string,unknown>,issuer='issuer')=>client.callTool({name,arguments:args,...(issuer?{_meta:{threadId:issuer}}:{})});
  return{store,apply,client,call,threads,reads};
}

test('C-380 只暴露受限AI创建绑定工具，通用event入口仍App专用',async()=>{
  const x=await fixture();const{tools}=await x.client.listTools();
  for(const name of ['cpm_create_card','cpm_create_session','cpm_bind'])expect(tools.find(t=>t.name===name)?._meta?.ui).toEqual({visibility:['model']});
  expect(tools.find(t=>t.name==='cpm_apply')?._meta?.ui).toEqual({visibility:['app']});
});
test('C-381 AI创建卡片严格审计为assistant，默认未开始且验收未勾选',async()=>{
  const x=await fixture();const response=await x.call('cpm_create_card',{requestId:'create-1',title:'AI代办卡',description:'范围',tags:['合成'],priority:'高',dueDate:'2026-10-31',acceptance:['真实证据']});
  expect(response.isError).not.toBe(true);
  const card=(response.structuredContent as any).card;expect(card).toMatchObject({title:'AI代办卡',status:'未开始',priority:'高',acceptance:[{content:'真实证据',checked:false,source:{kind:'assistant',id:'issuer'}}]});
  expect(x.store.getState().activities.at(-1)?.actor).toMatchObject({kind:'assistant',id:'issuer'});
});
test('C-382 创建请求同ID同参数不重复建卡，同ID变参拒绝且不写入',async()=>{
  const x=await fixture();const args={requestId:'same',title:'一次'};
  const a=await x.call('cpm_create_card',args),b=await x.call('cpm_create_card',args);
  expect(a.isError).not.toBe(true);expect(b.isError).not.toBe(true);expect((a.structuredContent as any).card.id).toBe((b.structuredContent as any).card.id);
  const before=x.store.getState();expect((await x.call('cpm_create_card',{...args,title:'偷偷改参数'})).isError).toBe(true);
  expect(x.store.getState()).toEqual(before);expect(before.cards.filter(c=>c.title==='一次')).toHaveLength(1);
});
test('C-383 生产AI可绑定当前会话，无Hook原话或假turn，返回受限首次同步',async()=>{
  const x=await fixture();x.threads.get('issuer')!.status='active';
  const response=await x.call('cpm_bind',{requestId:'bind-current',cardId:'card'});expect(response.isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='issuer')).toMatchObject({cardId:'card'});expect(x.store.getState().sessions.find(s=>s.id==='issuer')?.turn).toBeUndefined();
  expect(x.store.getState().activities.find(a=>a.type==='session.bind')?.actor).toMatchObject({kind:'assistant',id:'issuer'});
  expect((response.structuredContent as any).sync).toMatchObject({status:'dispatch'});expect((response.structuredContent as any).sync.prompt).toContain('cpm_report');
  expect((response.structuredContent as any).sync.prompt).not.toContain('send_message_to_thread');
});
test('C-384 AI换绑必须精确旧卡片，运行中仍待本轮结束',async()=>{
  const x=await fixture();x.apply('session.bind',{},{actor:{kind:'user'},sessionId:'issuer',cardId:'card'});
  expect((await x.call('cpm_bind',{requestId:'no-expected',cardId:'second'})).isError).toBe(true);
  x.apply('turn.start',{},{sessionId:'issuer',turnId:'running'});
  const changed=await x.call('cpm_bind',{requestId:'correct-expected',cardId:'second',expectedCurrentCardId:'card'});expect(changed.isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='issuer')).toMatchObject({cardId:'card',pendingCardId:'second',turn:{id:'running',cardId:'card'}});
  expect((changed.structuredContent as any).sync.status).toBe('deferred');
});
test('C-385 AI可绑定同项目其他真实会话，actor仍是发起者且同步目标准确',async()=>{
  const x=await fixture();const response=await x.call('cpm_bind',{requestId:'other-target',cardId:'card',targetSessionId:'target'});expect(response.isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='target')?.cardId).toBe('card');expect(x.store.getState().sessions.find(s=>s.id==='issuer')?.cardId).toBeUndefined();
  expect(x.store.getState().activities.find(a=>a.type==='session.bind')).toMatchObject({actor:{kind:'assistant',id:'issuer'},sessionId:'target'});
  const sync=(response.structuredContent as any).sync;expect(JSON.parse(sync.prompt.split('\n').at(-1)).threadId).toBe('target');
});
test('C-386 缺身份、缺官方provider或其他项目目标均拒绝写入',async()=>{
  const x=await fixture(),before=x.store.getState();
  expect((await x.call('cpm_create_card',{requestId:'missing',title:'不创建'},'')).isError).toBe(true);
  expect((await x.call('cpm_bind',{requestId:'foreign',cardId:'card',targetSessionId:'foreign'})).isError).toBe(true);
  expect(x.store.getState()).toEqual(before);
  const y=await fixture({host:false}),other=y.store.getState();expect((await y.call('cpm_create_card',{requestId:'no-host',title:'不创建'})).isError).toBe(true);expect(y.store.getState()).toEqual(other);
});
test('C-387 未登记issuer须指定已登记项目并官方验证；已有归属不能换项目冒充',async()=>{
  const x=await fixture({registered:false});expect((await x.call('cpm_create_card',{requestId:'no-project',title:'不猜项目'})).isError).toBe(true);
  expect((await x.call('cpm_create_card',{requestId:'explicit',projectId:'P',title:'明确项目'})).isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='issuer')?.projectId).toBe('P');
  const before=x.store.getState();expect((await x.call('cpm_create_card',{requestId:'wrong',projectId:'Q',title:'不跨项目'})).isError).toBe(true);expect(x.store.getState()).toEqual(before);
});
test('C-388 bind重复参数稳定，响应丢失重试不改后来的人工作用',async()=>{
  const x=await fixture();const args={requestId:'bind-once',cardId:'card'};expect((await x.call('cpm_bind',args)).isError).not.toBe(true);
  x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'issuer',cardId:'second'});
  const before=x.store.getState();expect((await x.call('cpm_bind',args)).isError).not.toBe(true);expect(x.store.getState()).toEqual(before);
  expect((await x.call('cpm_bind',{...args,cardId:'second'})).isError).toBe(true);expect(x.store.getState()).toEqual(before);
});
test('C-389 AI新会话工具准备真实官方指令，准确说明AI代办且不宣称已创建',async()=>{
  const x=await fixture();const response=await x.call('cpm_create_session',{requestId:'new-session',cardId:'card'});expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toMatchObject({status:'dispatch'});const prompt=(response.structuredContent as any).prompt;
  expect(prompt).toContain('create_thread');expect(prompt).toContain('AI 代办');expect(prompt).not.toContain('明确点击');
  expect(x.store.getState().sessions.find(s=>s.id==='new')).toBeUndefined();expect(x.store.getState().cards[0]?.members).toEqual([]);
});
test('C-390 AI创建请求未知结果不重新派发，同ID变更name拒绝',async()=>{
  const x=await fixture();const args={requestId:'unknown',cardId:'card',name:'请求一次'};
  expect((await x.call('cpm_create_session',args)).structuredContent).toMatchObject({status:'dispatch'});
  const repeated=await x.call('cpm_create_session',args);expect(repeated.structuredContent).toMatchObject({status:'pending'});expect(repeated.structuredContent).not.toHaveProperty('prompt');
  expect((await x.call('cpm_create_session',{...args,name:'变更'})).isError).toBe(true);
});
test('C-391 AI新会话认领沿原票据标assistant发起者，不冒充人工点击',async()=>{
  const x=await fixture();const created=await x.call('cpm_create_session',{requestId:'claim-ai',cardId:'card'});expect(created.isError).not.toBe(true);
  const payload=JSON.parse((created.structuredContent as any).prompt.split('\n').at(-1));const args=JSON.parse(payload.prompt.match(/参数 (\{[^\n]+?\})。/)[1]);
  const claimed=await x.call('cpm_claim',args,'new');expect(claimed.isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='new')?.cardId).toBe('card');
  expect(x.store.getState().activities.find(a=>a.type==='session.bind')).toMatchObject({actor:{kind:'assistant',id:'issuer'},sessionId:'new'});
});
test.each(['actor','status','id','event'])('C-392 AI建卡拒绝越权字段%s',async field=>{
  const x=await fixture();const before=x.store.getState();expect((await x.call('cpm_create_card',{requestId:'reject',title:'不越权',[field]:'forged'})).isError).toBe(true);expect(x.store.getState()).toEqual(before);
});
test('C-393 项目目录重叠回传官方候选，不登记issuer或猜测项目',async()=>{
  const x=await fixture({registered:false,ambiguous:true}),before=x.store.getState();const result=await x.call('cpm_create_card',{requestId:'ambiguous',projectId:'P',title:'不猜'});
  expect(result.structuredContent).toMatchObject({code:'PROJECT_AMBIGUOUS',projectCandidates:[{id:'one',name:'一'},{id:'two',name:'二'}]});expect(x.store.getState()).toEqual(before);
});
test('C-394 cpm_instruction生产继续关闭，不用AI代办旁路完成验收',async()=>{
  const x=await fixture();const before=x.store.getState();expect((await x.call('cpm_instruction',{quote:'这个算完成了',action:'complete'})).isError).toBe(true);expect(x.store.getState()).toEqual(before);
});
