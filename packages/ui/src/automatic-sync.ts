import type {Member,State} from '../../core/src/types.ts';
import {KnownToolError} from './client.ts';
import type {Client} from './client.ts';

export interface SyncTarget {projectId:string;cardId:string;sessionId:string}
export interface SyncReply extends SyncTarget {ok:true;action:'sync';requestId:string;status:'dispatch'|'disabled'|'deferred'|'complete'|'pending'|'recovery_required';turnId?:string;prompt?:string;message?:string}
export interface SyncNotice {busy:boolean;status?:SyncReply['status'];message:string;error?:boolean;turnId?:string}
export const syncKey=(target:Pick<SyncTarget,'cardId'|'sessionId'>)=>`${target.cardId}:${target.sessionId}`;
function validReply(raw:unknown,target:SyncTarget,requestId:string):SyncReply {
  const reply=raw as Partial<SyncReply>;
  if(!reply||reply.ok!==true||reply.action!=='sync'||reply.requestId!==requestId||reply.cardId!==target.cardId||reply.sessionId!==target.sessionId||!['dispatch','disabled','deferred','complete','pending','recovery_required'].includes(reply.status??''))throw new Error('未收到明确的同步结果，请查看原请求状态。');
  if(reply.status==='dispatch'&&!(typeof reply.prompt==='string'&&reply.prompt.trim()))throw new Error('同步指令不完整，请查看原请求状态。');
  if(reply.status==='recovery_required'&&!(typeof reply.turnId==='string'&&reply.turnId.trim()))throw new Error('恢复请求缺少原回合，请刷新同步状态。');
  return reply as SyncReply;
}
function wait(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}
/** A provided prompt and an acknowledged message are not evidence of a progress report. */
export class ReliableProgressSync {
  private requests=new Map<string,{requestId:string;generation?:string;attempted:boolean;retryable:boolean;reply?:SyncReply}>();
  constructor(private client:Pick<Client,'sessions'|'sendHostMessage'>,private timing={intervalMs:2000,maxWaitMs:30000}){}
  setCompletedGeneration(target:SyncTarget,generation:string|undefined){const request=this.requests.get(syncKey(target));if(request?.reply?.status==='complete')request.generation=generation;}
  pending(target:SyncTarget){const request=this.requests.get(syncKey(target));return !!request&&!request.retryable&&request.reply?.status!=='complete'&&request.reply?.status!=='disabled';}
  async run(target:SyncTarget,options:{manual?:boolean;recoverTurnId?:string;generation?:string;signal?:AbortSignal;onStatus?:(reply:SyncReply)=>void}={}):Promise<SyncReply>{
    options.signal?.throwIfAborted();const key=syncKey(target);let request=this.requests.get(key);
    if(options.recoverTurnId&&(!options.manual||request?.reply?.status!=='recovery_required'||request.reply.turnId!==options.recoverTurnId))throw new Error('恢复请求已变化，请先查看当前同步状态。');
    if(request?.reply?.status==='complete'&&!options.manual&&request.generation===options.generation){options.onStatus?.(request.reply);return request.reply;}
    if(!request||(request.retryable&&options.manual)||(request.reply?.status==='complete'&&(options.manual||request.generation!==options.generation))){request={requestId:crypto.randomUUID(),generation:options.generation,attempted:false,retryable:false};this.requests.set(key,request);}
    const limit=new AbortController();const timer=setTimeout(()=>limit.abort(new Error('本次等待已结束。请求可能仍在处理，可稍后查看同步状态。')),this.timing.maxWaitMs);
    const signal=options.signal?AbortSignal.any([options.signal,limit.signal]):limit.signal;
    let recovery=options.recoverTurnId;
    try{
      while(true){
        const args=recovery?{action:'recover',...target,requestId:request.requestId,expectedTurnId:recovery,confirmedStopped:true}:{action:'sync',...target,requestId:request.requestId};
        const reply=validReply(await this.client.sessions(args,{signal}),target,request.requestId);signal.throwIfAborted();recovery=undefined;request.reply=reply;options.onStatus?.(reply);
        if(reply.status==='complete'||reply.status==='disabled'||reply.status==='recovery_required')return reply;
        if(reply.status==='dispatch'&&!request.attempted){
          request.attempted=true;
          try{await this.client.sendHostMessage(reply.prompt!,signal);}catch(error){if(error instanceof KnownToolError)request.retryable=true;throw error;}
        }
        await wait(this.timing.intervalMs,signal);
      }
    }finally{clearTimeout(timer);}
  }
}

/** Current member joinedAt plus actual membership changes prevent an old report surviving a rebind. */
export function progressSyncEvidence(state:State,cardId:string,sessionId:string):{label:'等待首次同步'|'已同步'|'待补同步';at?:string;generation?:string}{
  const card=state.cards.find(card=>card.id===cardId);const session=state.sessions.find(session=>session.id===sessionId);
  const member=card?.members.find(member=>member.sessionId===sessionId);
  if(!card||!member||session?.cardId!==cardId)return {label:'等待首次同步'};
  const matches=(value:unknown)=>Array.isArray(value)&&value.some((item:Member)=>item.sessionId===sessionId&&item.joinedAt===member.joinedAt);
  const bound=state.activities.filter(activity=>activity.result!=='已退回'&&activity.changes.some(change=>change.collection==='cards'&&change.id===cardId&&change.field==='members'&&matches(change.after)&&!matches(change.before))).sort((a,b)=>b.revision-a.revision)[0];
  const report=state.activities.filter(activity=>activity.type==='report.submit'&&activity.cardId===cardId&&activity.sessionId===sessionId&&activity.result!=='已退回'&&activity.errors.length===0&&(bound?activity.revision>bound.revision:Date.parse(activity.at)>=Date.parse(member.joinedAt))).sort((a,b)=>b.revision-a.revision)[0];
  return {label:card.needsSync?'待补同步':report?'已同步':'等待首次同步',...(report?{at:report.at}:{}),generation:`${member.joinedAt}:${bound?.revision??''}`};
}
