import {describe,expect,it,vi} from 'vitest';
import {ProjectStore} from '../../core/src/index.ts';
import {KnownToolError} from './client.ts';
import {ReliableProgressSync,progressSyncEvidence} from './automatic-sync.ts';

const target={projectId:'p',cardId:'c',sessionId:'s'};
function reply(args:Record<string,unknown>,status:string,prompt?:string){return {ok:true,action:'sync',...target,requestId:args.requestId,status,...(prompt?{prompt}:{})};}
describe('自动同步进展（合成能力，仅 UI 局部）',()=>{
  it('C-350 绑定同步只派发一次，同 ID 查询直到真实报告确认',async()=>{
    const sessions=vi.fn(async args=>reply(args,sessions.mock.calls.length===1?'dispatch':'complete','合成指令'));
    const sendHostMessage=vi.fn(async()=>{});const sync=new ReliableProgressSync({sessions,sendHostMessage},{intervalMs:1,maxWaitMs:100});
    expect((await sync.run(target)).status).toBe('complete');expect(sendHostMessage).toHaveBeenCalledTimes(1);
    expect(new Set(sessions.mock.calls.map(([args])=>args.requestId)).size).toBe(1);
    await sync.run(target);expect(sendHostMessage).toHaveBeenCalledTimes(1);
    sync.setCompletedGeneration(target,'binding-after-deferred');const count=sessions.mock.calls.length;
    await sync.run(target,{generation:'binding-after-deferred'});expect(sessions).toHaveBeenCalledTimes(count);
  });
  it('C-351 宿主消息响应丢失只查询原请求，不再次发送',async()=>{
    const sessions=vi.fn(async args=>reply(args,sessions.mock.calls.length===1?'dispatch':'complete','合成指令'));
    const sendHostMessage=vi.fn(async()=>{throw new Error('响应丢失');});const sync=new ReliableProgressSync({sessions,sendHostMessage},{intervalMs:1,maxWaitMs:100});
    await expect(sync.run(target)).rejects.toThrow('响应丢失');await sync.run(target,{manual:true});
    expect(sendHostMessage).toHaveBeenCalledTimes(1);expect(new Set(sessions.mock.calls.map(([args])=>args.requestId)).size).toBe(1);
  });
  it('C-351 准备响应未知不能换 ID，明确发送拒绝才允许手动新请求',async()=>{
    const ids:unknown[]=[];let lost=true;const sessions=vi.fn(async args=>{ids.push(args.requestId);if(lost){lost=false;throw new Error('准备结果未知');}return reply(args,'complete');});
    const sync=new ReliableProgressSync({sessions,sendHostMessage:vi.fn()},{intervalMs:1,maxWaitMs:100});
    await expect(sync.run(target)).rejects.toThrow('未知');await sync.run(target,{manual:true});expect(ids[0]).toBe(ids[1]);
    const rejected=vi.fn(async args=>reply(args,'dispatch','合成指令'));const send=vi.fn(async()=>{throw new KnownToolError('明确未接受');});
    const retry=new ReliableProgressSync({sessions:rejected,sendHostMessage:send});await expect(retry.run(target)).rejects.toThrow('未接受');await expect(retry.run(target,{manual:true})).rejects.toThrow('未接受');
    expect(rejected.mock.calls[0]![0].requestId).not.toBe(rejected.mock.calls[1]![0].requestId);
  });
  it('C-352 运行中延后，同请求等待绑定生效后派发；卸载取消和等待上限停止查询',async()=>{
    const sessions=vi.fn(async args=>reply(args,['deferred','dispatch','complete'][sessions.mock.calls.length-1]??'complete','合成指令'));
    const sendHostMessage=vi.fn(async()=>{});const sync=new ReliableProgressSync({sessions,sendHostMessage},{intervalMs:1,maxWaitMs:100});
    await sync.run(target);expect(sendHostMessage).toHaveBeenCalledTimes(1);expect(new Set(sessions.mock.calls.map(([args])=>args.requestId)).size).toBe(1);
    const waiting=vi.fn(async args=>reply(args,'deferred'));const bounded=new ReliableProgressSync({sessions:waiting,sendHostMessage},{intervalMs:2,maxWaitMs:12});
    await expect(bounded.run(target)).rejects.toThrow('等待');const count=waiting.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,15));expect(waiting).toHaveBeenCalledTimes(count);
    const controller=new AbortController();controller.abort();await expect(bounded.run(target,{signal:controller.signal})).rejects.toThrow();expect(waiting).toHaveBeenCalledTimes(count);
  });
  it('C-353 未配置时明确 disabled、不发消息；配置后沿原 ID 重试',async()=>{
    let configured=false;const sessions=vi.fn(async args=>reply(args,configured?'complete':'disabled'));
    const sendHostMessage=vi.fn();const sync=new ReliableProgressSync({sessions,sendHostMessage});
    expect((await sync.run(target)).status).toBe('disabled');configured=true;await sync.run(target,{manual:true});
    expect(sendHostMessage).not.toHaveBeenCalled();expect(sessions.mock.calls[0]![0].requestId).toBe(sessions.mock.calls[1]![0].requestId);
  });
  it('C-354 仅最近实际绑定之后的成功 report 证明同步，绑定与运行不算',()=>{
    const store=new ProjectStore(':memory:');let n=0;
    const apply=(type:any,payload:Record<string,unknown>={},extra:Record<string,unknown>={})=>store.applyEvent({id:`e${++n}`,type,actor:{kind:'user'},payload,at:'2026-10-05T12:00:00.000Z',...extra} as any);
    try{
      apply('project.upsert',{id:'p',name:'合成',folder:'/synthetic'});const a=apply('card.create',{title:'甲'},{projectId:'p'}).cardId!;const b=apply('card.create',{title:'乙'},{projectId:'p'}).cardId!;
      apply('session.upsert',{id:'s',projectId:'p',name:'会话'});apply('session.bind',{}, {cardId:a,sessionId:'s'});
      const evidence=(cardId=a)=>progressSyncEvidence(store.getState(),cardId,'s');expect(evidence().label).toBe('等待首次同步');
      apply('turn.start',{number:1},{sessionId:'s',turnId:'t1',actor:{kind:'system'}});expect(evidence().label).toBe('等待首次同步');
      apply('report.submit',{fields:{progressText:'已整理资料'}},{sessionId:'s',turnId:'t1',actor:{kind:'session',id:'s'}});expect(evidence().label).toBe('已同步');
      apply('turn.end',{}, {sessionId:'s',turnId:'t1',actor:{kind:'system'}});apply('session.bind',{confirmed:true},{sessionId:'s',cardId:b});apply('session.bind',{confirmed:true},{sessionId:'s',cardId:a});
      expect(evidence().label).toBe('等待首次同步');
      apply('turn.start',{number:2},{sessionId:'s',turnId:'t2',actor:{kind:'system'}});apply('report.submit',{fields:{progressText:'新绑定的报告'}},{sessionId:'s',turnId:'t2',actor:{kind:'session',id:'s'}});expect(evidence().label).toBe('已同步');
      apply('sync.missing',{}, {cardId:a,actor:{kind:'system'}});expect(evidence().label).toBe('待补同步');
    }finally{store.close();}
  });
});

describe('C-553 遗留回合的显式恢复',()=>{
  it('C-553 recovery_required 停止轮询，明确确认后沿原请求恢复',async()=>{
    let confirmed=false;
    const sessions=vi.fn(async(args:Record<string,unknown>)=>{
      if(args.action==='recover'){expect(args.expectedTurnId).toBe('old-turn');expect(args.confirmedStopped).toBe(true);confirmed=true;return reply(args,'dispatch','受限同步');}
      return confirmed?reply(args,'complete'):{...reply(args,'recovery_required'),turnId:'old-turn',message:'需确认会话已停止'};
    });
    const sendHostMessage=vi.fn(async()=>{}),sync=new ReliableProgressSync({sessions,sendHostMessage},{intervalMs:1,maxWaitMs:100});
    expect((await sync.run(target)).status).toBe('recovery_required');expect(sessions).toHaveBeenCalledTimes(1);expect(sendHostMessage).not.toHaveBeenCalled();
    expect((await sync.run(target,{manual:true,recoverTurnId:'old-turn'} as any)).status).toBe('complete');
    expect(new Set(sessions.mock.calls.map(([args])=>args.requestId)).size).toBe(1);expect(sendHostMessage).toHaveBeenCalledTimes(1);
  });
  it('C-553 缺少匹配恢复票据不得请求recover',async()=>{
    const sessions=vi.fn(async(args:Record<string,unknown>)=>reply(args,'disabled'));
    const sync=new ReliableProgressSync({sessions,sendHostMessage:vi.fn()});
    await expect(sync.run(target,{manual:true,recoverTurnId:'forged'} as any)).rejects.toThrow();expect(sessions).not.toHaveBeenCalled();
  });
});
