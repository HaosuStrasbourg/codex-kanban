import { describe, expect, it } from 'vitest';
import { ReliableSessionCreates, sessionReply, sessionNamePreview, visibleSessions } from './session-ui.ts';
import { KnownToolError } from './client.ts';
import type { Session } from '../../core/src/types.ts';

describe('会话界面合同（合成响应，不代替真实 Codex 验收）',()=>{
  it('C-121 界面局部：名称预览包含当前项目的下一编号及标题，用户可自定义',()=>{
    expect(sessionNamePreview(12,'账号注销 PRD','')).toBe('#12 账号注销 PRD');
    expect(sessionNamePreview(3,'另一项目卡片','自定义会话')).toBe('自定义会话');
  });
  it('C-123 界面局部：只显示本项目会话，过滤后空列表就是空态',()=>{
    const sessions=[{id:'foreign',projectId:'p2',name:'项目外会话'}] as Session[];
    expect(visibleSessions(sessions,'p1')).toEqual([]);
  });
  it('C-227 界面局部：空响应或失败响应不能当作已打开会话',()=>{
    expect(()=>sessionReply('open',{})).toThrow();
    expect(()=>sessionReply('open',{ok:false,error:'会话不可用'})).toThrow('会话不可用');
    expect(sessionReply('open',{ok:true,action:'open',sessionId:'s1'})).toMatchObject({sessionId:'s1'});
  });
  it('C-129 界面局部：创建必须返回明确会话标识，拒绝不完整成功',()=>{
    expect(()=>sessionReply('create',{ok:true})).toThrow();
    expect(sessionReply('create',{ok:true,action:'create',sessionId:'s1'})).toMatchObject({sessionId:'s1'});
  });
  it('C-129 界面局部：未知结果重试保留requestId，明确成功后下次创建使用新ID',async()=>{
    const requests:Record<string,unknown>[]=[];let lose=true;
    const client={sessions:async(args:Record<string,unknown>)=>{requests.push(args);if(lose){lose=false;throw new Error('响应丢失');}return {ok:true,action:'create',sessionId:'s1'};}};
    const creates=new ReliableSessionCreates(client);const args={cardId:'c1',projectId:'p1',name:'#1 卡片'};
    await expect(creates.create(args)).rejects.toThrow('响应丢失');
    await creates.create(args);expect(requests[1]!.requestId).toBe(requests[0]!.requestId);
    await creates.create(args);expect(requests[2]!.requestId).not.toBe(requests[0]!.requestId);
  });
  it('C-129 界面局部：已知工具拒绝不被误当结果未知',async()=>{
    const requests:Record<string,unknown>[]=[];
    const creates=new ReliableSessionCreates({sessions:async(args)=>{requests.push(args);throw new KnownToolError('会话创建被拒绝');}});
    const args={cardId:'c1',projectId:'p1',name:'#1 卡片'};
    await expect(creates.create(args)).rejects.toThrow('被拒绝');await expect(creates.create(args)).rejects.toThrow('被拒绝');
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
  });
});

describe('异步会话桥接（仅合成合同）',()=>{
  it('C-121 桥接局部：先发送宿主消息，只有 complete 才完成',async()=>{
    const actions:string[]=[];let polls=0;
    const creates=new ReliableSessionCreates({sessions:async args=>{actions.push(String(args.action));return args.action==='create'?{ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'创建合成会话'}:++polls===1?{ok:true,status:'pending'}:{ok:true,status:'complete',sessionId:'s1'};},sendHostMessage:async()=>{actions.push('message');}},{intervalMs:1,maxWaitMs:100});
    const result=await creates.create({cardId:'c1',projectId:'p1',name:'卡片会话'});
    expect(actions).toEqual(['create','message','status','status']);expect(result.sessionId).toBe('s1');
  });
  it('C-129 桥接局部：发送失败重试保留 requestId；轮询中断重试不再发送',async()=>{
    const ids:unknown[]=[];let sends=0,polls=0;
    const creates=new ReliableSessionCreates({sessions:async args=>{if(args.action==='create'){ids.push(args.requestId);return {ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'创建合成会话'};}if(++polls===1)throw new Error('查询断开');return {ok:true,status:'complete',sessionId:'s1'};},sendHostMessage:async()=>{if(++sends===1)throw new KnownToolError('宿主消息未送达');}},{intervalMs:1,maxWaitMs:100});
    const args={cardId:'c1',projectId:'p1',name:'卡片会话'};
    await expect(creates.create(args)).rejects.toThrow('未送达');await expect(creates.create(args)).rejects.toThrow('查询断开');await creates.create(args);
    expect(new Set(ids).size).toBe(1);expect(sends).toBe(2);
  });
  it('C-129 桥接局部：过期不能误报为成功',async()=>{
    const creates=new ReliableSessionCreates({sessions:async args=>args.action==='create'?{ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'创建合成会话'}:{ok:true,status:'expired',message:'请求过期'},sendHostMessage:async()=>{}},{intervalMs:1,maxWaitMs:100});
    await expect(creates.create({cardId:'c1',projectId:'p1',name:'卡片会话'})).rejects.toThrow('请求过期');
  });
  it('C-129 桥接局部：停止等待后不再发送或轮询，且保留原请求',async()=>{
    const actions:string[]=[];const controller=new AbortController();
    const creates=new ReliableSessionCreates({sessions:async args=>{actions.push(String(args.action));return {ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'创建合成会话'};},sendHostMessage:async()=>{actions.push('message');controller.abort();}},{intervalMs:1,maxWaitMs:100});
    await expect(creates.create({cardId:'c1',projectId:'p1',name:'卡片会话'},{signal:controller.signal})).rejects.toThrow();expect(actions).toEqual(['create','message']);
  });
  it('C-129 桥接局部：等待有时限，不把超时当明确失败或成功',async()=>{
    const creates=new ReliableSessionCreates({sessions:async args=>args.action==='create'?{ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'创建合成会话'}:{ok:true,status:'pending'},sendHostMessage:async()=>{}},{intervalMs:2,maxWaitMs:4});
    await expect(creates.create({cardId:'c1',projectId:'p1',name:'卡片会话'})).rejects.toThrow('等待已达上限');
  });
});

it('C-129 桥接局部：重新打开后，同卡待请求只恢复查询，不新建或重发消息',async()=>{
  const actions:string[]=[];
  const creates=new ReliableSessionCreates({sessions:async args=>{actions.push(String(args.action));expect(args.requestId).toBe('pending-1');return {ok:true,status:'complete',sessionId:'s1'};},sendHostMessage:async()=>{actions.push('message');}},{intervalMs:1,maxWaitMs:100});
  creates.restore([{requestId:'pending-1',cardId:'c1',projectId:'p1',name:'旧名称',status:'claiming',issuedAt:1791158400000,expiresAt:1791158700000}]);
  await creates.create({cardId:'c1',projectId:'p1',name:'即使新名称也不新建'});expect(actions).toEqual(['status']);
});

it('C-129 桥接局部：服务端恢复中响应无 prompt，只轮询；过期明确提示核对',async()=>{
  const actions:string[]=[];let expired=false;
  const creates=new ReliableSessionCreates({sessions:async args=>{actions.push(String(args.action));if(args.action==='status')return {ok:true,status:'complete',sessionId:'s1'};return expired?{ok:true,action:'create',status:'expired',requestId:args.requestId,message:'原请求过期'}:{ok:true,action:'create',status:'pending',requestId:args.requestId,resume:true};},sendHostMessage:async()=>{actions.push('message');}},{intervalMs:1,maxWaitMs:100});
  const args={cardId:'c1',projectId:'p1',name:'会话'};expect((await creates.create(args)).sessionId).toBe('s1');expect(actions).toEqual(['create','status']);expired=true;await expect(creates.create(args)).rejects.toThrow('原请求过期');
});

it('C-121 项目歧义局部：用户确认项目后重试仍复用原 requestId',async()=>{
  const ids:unknown[]=[];let ambiguous=true;
  const creates=new ReliableSessionCreates({sessions:async args=>{ids.push(args.requestId);if(ambiguous){ambiguous=false;throw new KnownToolError('请选择项目',undefined,{code:'PROJECT_AMBIGUOUS',projectCandidates:[{id:'host-a',name:'工作项目'}]});}return {ok:true,action:'create',status:'complete',sessionId:'s1'};}});
  const args={cardId:'c1',projectId:'p1',name:'卡片会话'};await expect(creates.create(args)).rejects.toThrow('请选择项目');await creates.create(args);expect(ids[1]).toBe(ids[0]);
});

it('C-129 桥接局部：进度接口没有回应时也必须在等待上限中止',async()=>{
  const creates=new ReliableSessionCreates({sessions:async(args,options)=>{if(args.action==='create')return {ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'请求'};return new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(options.signal?.reason),{once:true}));},sendHostMessage:async()=>{}},{intervalMs:1,maxWaitMs:10});
  await expect(creates.create({cardId:'c1',projectId:'p1',name:'会话'})).rejects.toThrow('等待已达上限');
},250);

it('C-129 桥接局部：宿主收消息后响应丢失，重试只能查询，不重复派发',async()=>{
  const actions:string[]=[];
  const creates=new ReliableSessionCreates({sessions:async args=>{actions.push(String(args.action));return args.action==='create'?{ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'创建请求'}:{ok:true,status:'complete',sessionId:'s1'};},sendHostMessage:async()=>{actions.push('message');throw new Error('宿主已接收，响应丢失');}},{intervalMs:1,maxWaitMs:100});
  const args={cardId:'c1',projectId:'p1',name:'会话'};await expect(creates.create(args)).rejects.toThrow('响应丢失');await creates.create(args);expect(actions).toEqual(['create','message','status']);
});

it('C-129 过期恢复局部：TTL 过期后普通重试保留原 ID，不二次新建或派发',async()=>{
  const calls:Record<string,unknown>[]=[];let sends=0;
  const creates=new ReliableSessionCreates({sessions:async args=>{calls.push(args);return args.action==='create'?{ok:true,action:'create',status:'pending',requestId:args.requestId,prompt:'请求'}:{ok:true,status:'expired',message:'请求过期'};},sendHostMessage:async()=>{sends++;}},{intervalMs:1,maxWaitMs:100});
  const args={cardId:'c1',projectId:'p1',name:'会话'};await expect(creates.create(args)).rejects.toThrow('请求过期');await expect(creates.create(args)).rejects.toThrow('请求过期');
  expect(calls.filter(call=>call.action==='create')).toHaveLength(1);expect(sends).toBe(1);expect(new Set(calls.map(call=>call.requestId)).size).toBe(1);
});

it('C-129 过期恢复局部：后端拒绝 abandon 保留原请求，明确 abandoned 后才允许新建',async()=>{
  const calls:Record<string,unknown>[]=[];let allow=false,sends=0;
  const creates=new ReliableSessionCreates({sessions:async args=>{calls.push(args);if(args.action==='abandon'){if(!allow)throw new KnownToolError('原请求正在绑定，不能放弃');return {ok:true,action:'abandon',status:'abandoned',requestId:args.requestId};}return args.action==='create'?{ok:true,action:'create',status:'complete',sessionId:'new-session'}:{ok:true,status:'expired',message:'请求过期'};},sendHostMessage:async()=>{sends++;}},{intervalMs:1,maxWaitMs:100});
  creates.restore([{requestId:'expired-1',cardId:'c1',projectId:'p1',name:'会话',status:'expired',issuedAt:1,expiresAt:2}]);
  const args={cardId:'c1',projectId:'p1',name:'会话'};
  await expect(creates.abandon(args)).rejects.toThrow('不能放弃');await expect(creates.create(args)).rejects.toThrow('请求过期');expect(calls.filter(call=>call.action==='create')).toHaveLength(0);expect(sends).toBe(0);
  allow=true;await creates.abandon(args);await creates.create(args);expect(calls.at(-1)?.action).toBe('create');expect(calls.at(-1)?.requestId).not.toBe('expired-1');
});
