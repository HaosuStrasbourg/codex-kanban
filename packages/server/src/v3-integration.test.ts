import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import type { Event } from '../../core/src/types.ts';
import { CurrentPromptStore } from '../../hooks/src/prompt-store.ts';
import { HostMetadataError, type HostThread } from './host-metadata.ts';
import { createKanbanServer } from './server.ts';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(options:{verified?:Partial<HostThread>;hostAvailable?:boolean}={}){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'cpm-v3-integration-')));
  const store=new ProjectStore(':memory:');let seq=0;
  const apply=(type:Event['type'],payload:Record<string,unknown>,extra:Partial<Event>={})=>{
    const result=store.applyEvent({id:`setup-${++seq}`,type,actor:{kind:'system'},payload,...extra});
    expect(result.ok,result.errors.join()).toBe(true);return result;
  };
  apply('project.upsert',{id:'P',name:'合成项目',folder:directory,hostProjectId:'selected-b'},{actor:{kind:'user'}});
  for(const id of ['card','next','third'])apply('card.create',{id,title:id,dueDate:'2026-10-10'},{actor:{kind:'user'},projectId:'P'});
  for(const id of ['issuer','target'])apply('session.upsert',{id,name:id,projectId:'P'});
  apply('session.bind',{},{actor:{kind:'user'},cardId:'card',sessionId:'target'});
  const thread:HostThread={id:'target',name:'合成会话',projectId:'selected-b',canonicalProjectId:'selected-b',cwd:directory,createdAt:Date.now()/1000,updatedAt:Date.now()/1000,recencyAt:null,status:'idle',assignment:'canonical'};
  let beforeVerify:(()=>void)|undefined;
  let listFailed=false,verifyFailed=false;
  const hostMetadata={list:async(folder:string,canonical?:string)=>{expect(folder).toBe(directory);expect(canonical).toBe('selected-b');if(listFailed)throw new HostMetadataError('HOST_UNAVAILABLE');return {project:{id:'selected-b',name:'合成项目',roots:[directory]},threads:[thread]};},
    verify:async(folder:string,id:string,canonical?:string)=>{expect(folder).toBe(directory);expect(canonical).toBe('selected-b');if(verifyFailed)throw new HostMetadataError('THREAD_NOT_FOUND');beforeVerify?.();return {...thread,id,...options.verified};}};
  writeFileSync(join(directory,'hook-scope.json'),JSON.stringify({mode:'bound-sessions',projectIds:['P']}),{mode:0o600});
  const htmlPath=join(directory,'index.html');writeFileSync(htmlPath,'<title>synthetic</title>');
  const server=createKanbanServer({store,prompts:new CurrentPromptStore(directory),dataDir:directory,htmlPath,hostMetadata:options.hostAvailable===false?undefined:hostMetadata});
  const client=new Client({name:'v3-synthetic',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  cleanup.push(async()=>{await client.close();await server.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const call=(name:string,args:Record<string,unknown>,issuer='issuer')=>client.callTool({name,arguments:args,_meta:{threadId:issuer}});
  const sync=(extra:Record<string,unknown>={})=>call('cpm_sessions',{action:'sync',projectId:'P',cardId:'card',sessionId:'target',requestId:'sync-1',...extra});
  return {store,apply,thread,client,call,sync,onVerify:(fn?:()=>void)=>{beforeVerify=fn;},failHost:(listing:boolean,verification=false)=>{listFailed=listing;verifyFailed=verification;}};
}
function data(response:any):any{return response.structuredContent;}
function reportId(response:any):string{return JSON.parse(data(response).prompt.split('\n').at(-1)).prompt.match(/"reportId":"([^"]+)"/)[1];}

test('C-552 首次报告部分生效结束等待并显示未采纳字段，整体拒绝仍等待',async()=>{
  const x=await fixture();const id=reportId(await x.sync());x.apply('turn.start',{},{sessionId:'target',turnId:'t1'});
  const rejected=await x.call('cpm_report',{reportId:id,fields:{status:'不存在的状态'}},'target');
  expect(rejected.isError).toBe(true);expect(data(await x.sync()).status).toBe('pending');
  const partial=await x.call('cpm_report',{reportId:id,fields:{progressText:'已调研',dueDate:'2026-10-20'}},'target');
  expect(partial.isError).not.toBe(true);expect(data(partial).result.warnings.length).toBeGreaterThan(0);
  const finished=data(await x.sync());expect(finished.status).toBe('complete');expect(finished.warnings.length).toBeGreaterThan(0);expect(finished.message).toContain('部分');
  expect(x.store.getState().cards.find(c=>c.id==='card')).toMatchObject({progressText:'已调研',dueDate:'2026-10-10'});
  expect(finished).not.toHaveProperty('prompt');
});

test('C-553 宿主idle仅提示恢复；明确确认同一遗留回合后收尾一次并派发一次',async()=>{
  const x=await fixture();x.apply('turn.start',{},{sessionId:'target',turnId:'lost-stop'});const before=x.store.getState();
  expect(data(await x.sync())).toMatchObject({status:'recovery_required',turnId:'lost-stop'});expect(x.store.getState()).toEqual(before);
  expect((await x.sync({action:'recover',expectedTurnId:'lost-stop'})).isError).toBe(true);expect(x.store.getState()).toEqual(before);
  const recovered=await x.sync({action:'recover',expectedTurnId:'lost-stop',confirmedStopped:true});expect(data(recovered).status).toBe('dispatch');
  const session=x.store.getState().sessions.find(s=>s.id==='target')!;expect(session.turn).toBeUndefined();
  expect(x.store.getState().cards.find(c=>c.id==='card')).toMatchObject({status:'未开始',needsSync:true});
  expect(data(await x.sync({action:'recover',expectedTurnId:'lost-stop',confirmedStopped:true})).status).toBe('pending');
  expect(x.store.getState().activities.filter(a=>a.type==='turn.end'&&a.turnId==='lost-stop')).toHaveLength(1);
  expect((await x.call('cpm_report',{reportId:'late',noChange:true},'target')).isError).toBe(true);
  x.apply('turn.start',{},{sessionId:'target',turnId:'new-real-turn'});
  expect((await x.call('cpm_report',{reportId:reportId(recovered),fields:{progressText:'恢复后实际进展'}},'target')).isError).not.toBe(true);
  expect(data(await x.sync()).status).toBe('complete');
});

test('C-553 仍active或恢复核验期间新回合替换旧回合均不收尾',async()=>{
  const x=await fixture();x.apply('turn.start',{},{sessionId:'target',turnId:'old'});x.thread.status='active';const before=x.store.getState();
  expect(data(await x.sync()).status).toBe('deferred');expect((await x.sync({action:'recover',expectedTurnId:'old',confirmedStopped:true})).isError).toBe(true);expect(x.store.getState()).toEqual(before);
  x.thread.status='idle';x.onVerify(()=>{x.onVerify();x.apply('turn.start',{},{sessionId:'target',turnId:'new'});});
  expect((await x.sync({action:'recover',expectedTurnId:'old',confirmedStopped:true})).isError).toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='target')?.turn?.id).toBe('new');
  expect(x.store.getState().activities.filter(a=>a.type==='turn.end')).toHaveLength(0);
});

test('C-553 恢复遗留回合后待换绑生效且首次同步固定新卡',async()=>{
  const x=await fixture();x.apply('turn.start',{},{sessionId:'target',turnId:'old'});x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},cardId:'next',sessionId:'target'});
  expect(data(await x.sync({cardId:'next'}))).toMatchObject({status:'recovery_required',turnId:'old'});
  const recovered=await x.sync({action:'recover',cardId:'next',expectedTurnId:'old',confirmedStopped:true});expect(data(recovered).status).toBe('dispatch');
  expect(x.store.getState().sessions.find(s=>s.id==='target')).toMatchObject({cardId:'next'});
  expect(data(recovered).prompt).toContain('\\"expectedCardId\\":\\"next\\"');
  expect(x.store.getState().cards.find(c=>c.id==='card')?.members).toHaveLength(0);
});

test('C-656 人工旧确认不覆盖中间换绑，刷新期待值后才生效',async()=>{
  const x=await fixture();x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'target',cardId:'third'});
  const bind=(id:string,current:string)=>x.call('cpm_apply',{event:{id,type:'session.bind',sessionId:'target',cardId:'next',payload:{confirmed:true,expectedCurrentCardId:current,expectedPendingCardId:null}}});
  expect((await bind('stale','card')).isError).toBe(true);expect(x.store.getState().sessions.find(s=>s.id==='target')?.cardId).toBe('third');
  expect((await bind('fresh','third')).isError).not.toBe(true);expect(x.store.getState().sessions.find(s=>s.id==='target')?.cardId).toBe('next');
});

test('C-660 同一创建票据在明确绑定拒绝后可修正重试且不重复创建或覆盖后续手动换绑',async()=>{
  const x=await fixture();const created=await x.call('cpm_create_session',{requestId:'create-once',projectId:'P',cardId:'next'});
  const bootstrap=JSON.parse(data(created).prompt.split('\n').at(-1)).prompt;
  const ticket=JSON.parse(bootstrap.match(/参数 (\{[^\n]+?\})。/)[1]);
  x.apply('card.archive',{archived:true},{actor:{kind:'user'},cardId:'next'});
  expect((await x.call('cpm_claim',ticket,'new')).isError).toBe(true);
  expect(x.store.getState().cards.find(c=>c.id==='next')?.members).toHaveLength(0);
  expect((await x.call('cpm_claim',ticket,'another-new')).isError).toBe(true);
  x.apply('card.archive',{archived:false},{actor:{kind:'user'},cardId:'next'});
  expect((await x.call('cpm_claim',ticket,'new')).isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='new')?.cardId).toBe('next');
  x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},cardId:'third',sessionId:'new'});
  const confirmedState=x.store.getState();
  expect((await x.call('cpm_claim',ticket,'new')).isError).not.toBe(true);
  expect(x.store.getState()).toEqual(confirmedState);
  expect(x.store.getState().sessions.find(s=>s.id==='new')?.cardId).toBe('third');
  expect(x.store.getState().sessions.filter(s=>s.id==='new')).toHaveLength(1);
  expect(data(await x.call('cpm_create_session',{requestId:'create-once',projectId:'P',cardId:'next'}))).not.toHaveProperty('prompt');
});

test('C-659 绑定同步交付卡片描述与验收上下文但不复制历史或变更原会话名称',async()=>{
  const x=await fixture();x.apply('card.update',{fields:{description:'仅核查当前材料'}},{actor:{kind:'user'},cardId:'card'});
  x.apply('checklist.add',{list:'acceptance',content:'附原始证据链接'},{actor:{kind:'user'},cardId:'card'});
  const before=x.store.getState();const response=await x.sync();const prompt=JSON.parse(data(response).prompt.split('\n').at(-1)).prompt;
  expect(prompt).toContain('仅核查当前材料');expect(prompt).toContain('附原始证据链接');expect(prompt).toContain('不读取历史会话正文');
  expect(x.store.getState()).toEqual(before);
  x.apply('turn.start',{},{sessionId:'target',turnId:'context-report'});
  expect((await x.call('cpm_report',{reportId:reportId(response),noChange:true},'target')).isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='target')).toMatchObject({id:'target',name:'target',projectId:'P',cardId:'card'});
  expect(x.store.getState().cards.find(c=>c.id==='card')).toMatchObject({progressText:'',status:'未开始',acceptance:[{checked:false}]});
});

test('C-656 待换绑目标变化使旧确认失效，刷新期待值后仍在原轮末生效',async()=>{
  const x=await fixture();x.apply('turn.start',{},{sessionId:'target',turnId:'running'});
  x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'target',cardId:'third'});
  const bind=(id:string,pending:string|null)=>x.call('cpm_apply',{event:{id,type:'session.bind',sessionId:'target',cardId:'next',payload:{confirmed:true,expectedCurrentCardId:'card',expectedPendingCardId:pending}}});
  expect((await bind('stale-pending',null)).isError).toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='target')).toMatchObject({cardId:'card',pendingCardId:'third'});
  expect((await bind('fresh-pending','third')).isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='target')).toMatchObject({cardId:'card',pendingCardId:'next',turn:{id:'running'}});
});

test.each(['app','assistant'])('C-668 %s创建指令保留已选canonical项目ID和准确根目录',async origin=>{
  const x=await fixture();const response=origin==='app'?await x.call('cpm_sessions',{action:'create',projectId:'P',cardId:'next',requestId:'canonical',name:'预览名称'}):await x.call('cpm_create_session',{projectId:'P',cardId:'next',requestId:'canonical',name:'预览名称'});
  const payload=JSON.parse(data(response).prompt.split('\n').at(-1));
  expect(payload.projectId).toBe('selected-b');expect(payload.folder).toBe(x.thread.cwd);expect(payload.title).toBe('预览名称');
  expect(data(response).prompt).toContain('projectId');expect(payload.prompt).toContain('cpm_claim');expect(payload.prompt).toContain('不启动原任务');
});

test('C-687 列表失败保留登记与绑定，恢复幂等；缓存不能绕过打开和同步的实时身份核验',async()=>{
  const x=await fixture();await x.call('cpm_sessions',{action:'list',projectId:'P'});const before=x.store.getState();
  x.failHost(true);const failed=await x.call('cpm_sessions',{action:'list',projectId:'P'});
  expect(failed.isError).toBe(true);expect(data(failed).message).toContain('读取未完成');expect(x.store.getState()).toEqual(before);
  x.failHost(false);x.thread.name='恢复后的真实名称';x.thread.updatedAt+=3600;
  expect((await x.call('cpm_sessions',{action:'list',projectId:'P'})).isError).not.toBe(true);
  const recovered=x.store.getState();expect(recovered.sessions.find(s=>s.id==='target')).toMatchObject({name:'恢复后的真实名称',cardId:'card'});
  await x.call('cpm_sessions',{action:'list',projectId:'P'});expect(x.store.getState()).toEqual(recovered);
  x.failHost(false,true);
  expect((await x.call('cpm_sessions',{action:'open',projectId:'P',sessionId:'target'})).isError).toBe(true);
  expect((await x.sync()).isError).toBe(true);expect(x.store.getState()).toEqual(recovered);
});


test('C-205 工具schema列明报告字段并给可执行卡点与证据例子，不增加blockers字段别名',async()=>{
  const x=await fixture();const tool=(await x.client.listTools()).tools.find(t=>t.name==='cpm_report')!;
  const props=tool.inputSchema.properties as any;
  expect(props.fields.properties).toHaveProperty('progressText');expect(props.fields.properties).toHaveProperty('dueDate');
  expect(props.fields.properties).not.toHaveProperty('blockers');expect(props.fields.description).toContain('operations');
  expect(props.operations.items.properties.payload.properties).toHaveProperty('waitingFor');
  expect(props.operations.items.properties.payload.properties).toHaveProperty('evidence');
  const operations=JSON.parse(props.operations.description.split('示例：')[1]);
  x.apply('checklist.add',{id:'accept-1',list:'acceptance',content:'合成验收'},{actor:{kind:'user'},cardId:'card'});
  operations.find((op:any)=>op.type==='acceptance.evidence').payload.itemId=x.store.getState().cards.find(c=>c.id==='card')!.acceptance[0]!.id;
  x.apply('turn.start',{},{sessionId:'target',turnId:'format'});
  const response=await x.call('cpm_report',{reportId:'format-1',operations},'target');expect(response.isError).not.toBe(true);
  expect(data(response).result.status).toBe('applied');const card=x.store.getState().cards.find(c=>c.id==='card')!;
  expect(card.blockers).toMatchObject([{blocking:true,waitingFor:'我'}]);expect(card.acceptance[0]?.evidence).toMatchObject([{kind:'document',reference:expect.any(String),detail:expect.any(String)}]);expect(card.acceptance[0]?.checked).toBe(false);
});

test('C-205 部分生效与重复明确说明忽略项；仅修正未采纳操作的新报告可补录',async()=>{
  const x=await fixture();x.apply('checklist.add',{id:'accept-1',list:'acceptance',content:'合成验收'},{actor:{kind:'user'},cardId:'card'});x.apply('turn.start',{},{sessionId:'target',turnId:'partial-format'});
  const itemId=x.store.getState().cards.find(c=>c.id==='card')!.acceptance[0]!.id;
  const malformed={reportId:'partial-1',fields:{progressText:'已核对合成材料',blockers:[{content:'等待材料',blocking:true}]},operations:[{type:'acceptance.evidence',payload:{itemId,text:'错误形状'}}]};
  const response=await x.call('cpm_report',malformed,'target');expect(data(response).result.status).toBe('partial');
  expect(data(response).message).toContain('部分生效');expect(data(response).message).toContain('证据须为对象');expect(data(response).message).toContain('blockers');expect(data(response).message).toContain('新 reportId');
  const partialState=x.store.getState();expect(partialState.activities.at(-1)?.result).toBe('部分生效');expect(partialState.cards.find(c=>c.id==='card')).toMatchObject({progressText:'已核对合成材料',blockers:[],acceptance:[{evidence:[],checked:false}]});
  const duplicate=await x.call('cpm_report',malformed,'target');expect(data(duplicate).result.status).toBe('duplicate');expect(data(duplicate).message).toContain('重复');expect(data(duplicate).message).toContain('部分生效');expect(x.store.getState()).toEqual(partialState);
  const repaired=await x.call('cpm_report',{reportId:'partial-repair',operations:[{type:'checklist.add',payload:{list:'blockers',content:'等待材料',blocking:true,waitingFor:'我'}},{type:'acceptance.evidence',payload:{itemId,evidence:{kind:'document',reference:'synthetic.md',detail:'第1节合成摘要'}}}]},'target');
  expect(data(repaired).result.status).toBe('applied');expect(x.store.getState().cards.find(c=>c.id==='card')).toMatchObject({progressText:'已核对合成材料',blockers:[{content:'等待材料',waitingFor:'我'}],acceptance:[{evidence:[{kind:'document'}],checked:false}]});
  const repairedState=x.store.getState();const again=await x.call('cpm_report',{reportId:'partial-repair',noChange:true},'target');expect(data(again).message).toContain('重复');expect(x.store.getState()).toEqual(repairedState);
});

test('C-205 退回消息包含core原因，错误字段仍留审计且修正同ID可提交',async()=>{
  const x=await fixture();x.apply('turn.start',{},{sessionId:'target',turnId:'rejected-format'});
  const invalid={reportId:'rejected-1',fields:{progressText:42}};
  const response=await x.call('cpm_report',invalid,'target');expect(response.isError).toBe(true);expect(data(response).result.status).toBe('rejected');expect(data(response).message).toContain('progressText须为字符串');
  expect(x.store.getState().activities.at(-1)?.result).toBe('已退回');const state=x.store.getState();
  const duplicate=await x.call('cpm_report',invalid,'target');expect(duplicate.isError).toBe(true);expect(data(duplicate).message).toContain('重复');expect(data(duplicate).message).toContain('退回');expect(x.store.getState()).toEqual(state);
  const fixed=await x.call('cpm_report',{reportId:'rejected-1',fields:{progressText:'已修正'}},'target');expect(data(fixed).result.status).toBe('applied');expect(x.store.getState().cards.find(c=>c.id==='card')?.progressText).toBe('已修正');
});

test.each(['idle-turn','pending-rebind','active-without-turn'])('C-344 同目标%s仍须恢复或等待，不绕过真实回合和待换绑',async mode=>{
  const x=await fixture();x.thread.status=mode==='idle-turn'?'idle':'active';
  if(mode!=='active-without-turn')x.apply('turn.start',{},{sessionId:'target',turnId:'current'});
  if(mode==='pending-rebind')x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'target',cardId:'next'});
  const before=x.store.getState();const response=await x.call('cpm_sessions',{action:'sync',projectId:'P',sessionId:'target',cardId:mode==='pending-rebind'?'next':'card',requestId:'self-guard'},'target');
  expect(data(response).status).toBe(mode==='idle-turn'?'recovery_required':'deferred');expect(data(response)).not.toHaveProperty('prompt');expect(x.store.getState()).toEqual(before);
});


test('C-687 缓存会话失效时人工换绑拒绝；官方核验恢复后相同请求可成功一次',async()=>{
  const x=await fixture();await x.call('cpm_sessions',{action:'list',projectId:'P'});x.failHost(true,true);
  const event={id:'cached-bind',type:'session.bind',sessionId:'target',cardId:'next',payload:{confirmed:true,expectedCurrentCardId:'card',expectedPendingCardId:null}};
  const before=x.store.getState();const failed=await x.call('cpm_apply',{event});
  expect(failed.isError).toBe(true);expect(data(failed).code).toBe('THREAD_NOT_FOUND');expect(x.store.getState()).toEqual(before);
  x.failHost(false);expect((await x.call('cpm_apply',{event})).isError).not.toBe(true);
  expect(x.store.getState().sessions.find(s=>s.id==='target')?.cardId).toBe('next');const bound=x.store.getState();
  expect(data(await x.call('cpm_apply',{event})).result.status).toBe('duplicate');expect(x.store.getState()).toEqual(bound);
});

test.each([{verified:{id:'foreign'}},{verified:{canonicalProjectId:'other-project'}},{hostAvailable:false}])('C-687 人工绑定拒绝缺失或矛盾的官方身份 %j',async options=>{
  const x=await fixture(options);const before=x.store.getState();
  const failed=await x.call('cpm_apply',{event:{id:'invalid-bind',type:'session.bind',sessionId:'target',cardId:'next',payload:{confirmed:true}}});
  expect(failed.isError).toBe(true);expect(x.store.getState()).toEqual(before);
});

test.each(['current','pending'])('C-687 核验期间%s绑定变化时事务CAS拒绝覆盖，即使旧调用未带期待值',async kind=>{
  const x=await fixture();if(kind==='pending')x.apply('turn.start',{},{sessionId:'target',turnId:'ongoing'});
  let afterConcurrent=x.store.getState();x.onVerify(()=>{x.onVerify();x.apply('session.bind',{confirmed:true},{actor:{kind:'user'},sessionId:'target',cardId:'third'});afterConcurrent=x.store.getState();});
  const failed=await x.call('cpm_apply',{event:{id:'racing-bind',type:'session.bind',sessionId:'target',cardId:'next',payload:{confirmed:true}}});
  expect(failed.isError).toBe(true);expect(data(failed).result.errors.join()).toContain('绑定已变化');
  const after=x.store.getState();expect(after.sessions).toEqual(afterConcurrent.sessions);expect(after.cards).toEqual(afterConcurrent.cards);
});

test('C-687 核验期间项目映射改变后拒绝使用旧核验结果绑定',async()=>{
  const x=await fixture();let afterConcurrent=x.store.getState();x.onVerify(()=>{x.onVerify();x.apply('project.upsert',{id:'P',name:'合成项目',folder:x.thread.cwd,hostProjectId:'new-mapping'},{actor:{kind:'user'}});afterConcurrent=x.store.getState();});
  const failed=await x.call('cpm_apply',{event:{id:'mapping-race',type:'session.bind',sessionId:'target',cardId:'next',payload:{confirmed:true}}});
  expect(failed.isError).toBe(true);expect(data(failed).message).toContain('项目映射已变化');expect(x.store.getState()).toEqual(afterConcurrent);
});

test.each(['已归档','找不到'].flatMap(status=>[false,true].map(turn=>({status,turn}))))('C-527 官方恢复$status（已有回合:$turn）关闭对应通知且保留卡片业务和其他成员',async({status,turn})=>{
  const x=await fixture();x.apply('session.bind',{},{actor:{kind:'user'},sessionId:'issuer',cardId:'card'});
  x.apply('checklist.add',{list:'blockers',content:'等待外部答复',blocking:false,waitingFor:'外部'},{actor:{kind:'user'},cardId:'card'});
  if(turn)x.apply('turn.start',{},{sessionId:'target',turnId:'preserve-turn'});
  await x.call('cpm_sessions',{action:'list',projectId:'P'});
  const initial=x.store.getState(),target=initial.sessions.find(s=>s.id==='target')!;
  const cardBusiness=(card:any)=>{const {updatedAt,members,flags,...rest}=card;return rest;};
  for(let cycle=0;cycle<2;cycle++){
    x.apply('session.upsert',{id:'target',projectId:'P',status,lastActivityAt:target.lastActivityAt});
    const before=x.store.getState(),cardBefore=before.cards.find(c=>c.id==='card')!;
    const unavailable=before.notifications.find(n=>n.type==='主会话不可用'&&n.active)!;expect(unavailable).toBeTruthy();
    const external=before.notifications.find(n=>n.type==='卡点（等外部，需我跟进）')!;
    expect((await x.call('cpm_sessions',{action:'list',projectId:'P'})).isError).not.toBe(true);
    const recovered=x.store.getState(),card=recovered.cards.find(c=>c.id==='card')!;
    expect(recovered.sessions.find(s=>s.id==='target')).toEqual({...target,status:turn?'运行中':'空闲'});
    expect(card.members.find(m=>m.sessionId==='target')).toMatchObject({role:'主会话',status:turn?'运行中':'空闲'});
    expect(card.members.find(m=>m.sessionId==='issuer')).toEqual(cardBefore.members.find(m=>m.sessionId==='issuer'));
    expect(card.flags).not.toContain('主会话不可用');expect(cardBusiness(card)).toEqual(cardBusiness(cardBefore));
    expect(recovered.notifications.find(n=>n.id===unavailable.id)).toMatchObject({active:false,status:'已处理'});
    expect(recovered.notifications.find(n=>n.id===external.id)).toEqual(external);
    await x.call('cpm_sessions',{action:'list',projectId:'P'});expect(x.store.getState()).toEqual(recovered);
  }
  expect(x.store.getState().activities.filter(a=>a.type==='turn.end')).toHaveLength(0);
});

test.each(['before-claim','during-verify'])('C-660 看板创建票据在%s归档后拒绝认领，恢复后原目标原票据只绑定一次',async timing=>{
  const x=await fixture();const requestId='app-claim-recovery';
  const created=await x.call('cpm_sessions',{action:'create',requestId,projectId:'P',cardId:'next'});
  const bootstrap=JSON.parse(data(created).prompt.split('\n').at(-1)).prompt;const ticket=JSON.parse(bootstrap.match(/参数 (\{[^\n]+?\})。/)[1]);
  const archive=()=>x.apply('card.archive',{archived:true},{actor:{kind:'user'},cardId:'next'});
  if(timing==='before-claim')archive();else{let reads=0;x.onVerify(()=>{if(++reads===2){x.onVerify();archive();}});}
  const failed=await x.call('cpm_claim',ticket,'new');expect(failed.isError).toBe(true);expect(data(failed).message).toContain('归档');expect(data(failed)).not.toHaveProperty('claimed');
  expect(x.store.getState().cards.find(c=>c.id==='next')?.members).toHaveLength(0);expect(x.store.getState().sessions.find(s=>s.id==='new')?.cardId).toBeUndefined();
  expect(data(await x.call('cpm_sessions',{action:'status',requestId}))).toMatchObject({status:'pending',sessionId:'new'});
  expect((await x.call('cpm_claim',ticket,'another-new')).isError).toBe(true);
  x.apply('card.archive',{archived:false},{actor:{kind:'user'},cardId:'next'});
  expect(data(await x.call('cpm_claim',ticket,'new')).claimed).toMatchObject({status:'claimed',targetId:'new',duplicate:false});
  const bound=x.store.getState();expect(bound.cards.find(c=>c.id==='next')?.members.filter(m=>m.sessionId==='new')).toHaveLength(1);
  expect(data(await x.call('cpm_claim',ticket,'new')).claimed.duplicate).toBe(true);expect(x.store.getState()).toEqual(bound);
  expect(data(await x.call('cpm_sessions',{action:'create',requestId,projectId:'P',cardId:'next'}))).not.toHaveProperty('prompt');
});

test('C-660 看板票据的卡片已删除时认领拒绝，不留下有效成员或称成功',async()=>{
  const x=await fixture();const created=await x.call('cpm_sessions',{action:'create',requestId:'deleted-target',projectId:'P',cardId:'next'});
  const bootstrap=JSON.parse(data(created).prompt.split('\n').at(-1)).prompt;const ticket=JSON.parse(bootstrap.match(/参数 (\{[^\n]+?\})。/)[1]);
  x.apply('card.archive',{archived:true},{actor:{kind:'user'},cardId:'next'});x.apply('card.delete',{},{actor:{kind:'user'},cardId:'next'});
  const failed=await x.call('cpm_claim',ticket,'new');expect(failed.isError).toBe(true);expect(data(failed)).not.toHaveProperty('claimed');
  expect(x.store.getState().cards.find(c=>c.id==='next')?.members).toHaveLength(0);expect(x.store.getState().sessions.find(s=>s.id==='new')?.cardId).toBeUndefined();
});
