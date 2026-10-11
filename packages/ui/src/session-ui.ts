import type { Session, State } from '../../core/src/types.ts';
import { KnownToolError } from './client.ts';
import type { Client, PendingSessionRequest } from './client.ts';
export type SessionAction='list'|'create'|'open';
export type SessionPhase='preparing'|'sending'|'waiting'|'checking';
export interface SessionReply {ok:true;action:SessionAction;sessions?:Session[];sessionId?:string;state?:State;status?:'pending'|'dispatch'|'complete'|'expired'|'failed';requestId?:string;prompt?:string;resume?:boolean;message?:string;warnings?:string[]}
export interface SessionStatusReply {ok:true;status:'pending'|'complete'|'expired'|'failed';sessionId?:string;message?:string;state?:State}
export function sessionNamePreview(nextNo:number,title:string,customName:string):string{return customName.trim()||`#${nextNo} ${title.trim()||'卡片标题'}`;}
export function visibleSessions(sessions:Session[],projectId:string):Session[]{return sessions.filter(session=>session.projectId===projectId);}
const nonempty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();
/** A missing/error response is not evidence that the desktop performed an action. */
export function sessionReply(action:SessionAction,raw:unknown):SessionReply {
  const reply=raw as Partial<SessionReply>&{error?:string;message?:string};
  if(reply&&typeof reply==='object'&&(reply.error||(reply.ok!==true&&reply.message)))throw new KnownToolError(reply.error??reply.message!,reply.state);
  if(!reply||typeof reply!=='object'||reply.ok!==true)throw new Error('未收到明确的会话操作结果，请刷新后核对。');
  if(reply.action!==action)throw new Error('会话操作结果与请求不一致，请刷新后核对。');
  if(action==='list'&&!Array.isArray(reply.sessions))throw new Error('未收到有效的会话列表，请重试。');
  if(action==='create'&&reply.status==='pending'){
    if(!nonempty(reply.requestId)||(reply.resume!==true&&!nonempty(reply.prompt)))throw new Error('创建请求缺少编号或宿主指令，尚未发送。');
  }else if(action==='create'&&(reply.status==='expired'||reply.status==='failed')){
    if(!nonempty(reply.requestId))throw new Error('创建结果缺少请求编号。');
  }else if(action!=='list'&&!nonempty(reply.sessionId))throw new Error('会话操作未返回对应会话，请刷新后核对。');
  if(action==='open'&&reply.status==='dispatch'&&!nonempty(reply.prompt))throw new Error('打开请求缺少宿主指令，尚未发送。');
  return reply as SessionReply;
}
export function sessionStatusReply(raw:unknown):SessionStatusReply {
  const reply=raw as Partial<SessionStatusReply>;
  if(!reply||reply.ok!==true||!['pending','complete','expired','failed'].includes(reply.status??''))throw new Error('未收到明确的创建进度，请重试查询。');
  if(reply.status==='complete'&&!nonempty(reply.sessionId))throw new Error('创建结果缺少会话编号，请重试查询。');
  return reply as SessionStatusReply;
}
function wait(ms:number,signal?:AbortSignal){
  signal?.throwIfAborted();
  return new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal?.reason??new Error('已停止等待'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});
}
/** Keep unresolved IDs through message/poll failures; retries after dispatch only resume polling. */
export class ReliableSessionCreates {
  private unresolved=new Map<string,{requestId:string;cardId:string;projectId:string;prepared?:SessionReply;dispatched:boolean;acknowledged:boolean;expired?:boolean}>();
  constructor(private client:Pick<Client,'sessions'>&Partial<Pick<Client,'sendHostMessage'>>,private timing={intervalMs:2000,maxWaitMs:300000}){}
  restore(requests:PendingSessionRequest[]){
    for(const pending of requests){
      const existing=[...this.unresolved.values()].find(request=>request.requestId===pending.requestId);
      const expired=pending.status==='expired'||pending.expiresAt<=Date.now();
      if(existing){if(expired){existing.expired=true;existing.dispatched=true;}continue;}
      const signature=JSON.stringify([pending.cardId,pending.projectId,pending.name??'']);
      this.unresolved.set(signature,{requestId:pending.requestId,cardId:pending.cardId,projectId:pending.projectId,prepared:{ok:true,action:'create',status:'pending',requestId:pending.requestId},dispatched:true,acknowledged:false,expired});
    }
  }
  pendingRequest(cardId:string,projectId:string){const request=[...this.unresolved.values()].find(request=>request.cardId===cardId&&request.projectId===projectId);return request?{requestId:request.requestId,expired:request.expired===true}:undefined;}
  async abandon(args:{cardId:string;projectId:string},signal?:AbortSignal){
    const entry=[...this.unresolved.entries()].find(([,request])=>request.cardId===args.cardId&&request.projectId===args.projectId);
    if(!entry)throw new KnownToolError('没有可放弃的原请求，请先刷新核对。');
    const [signature,request]=entry;
    const reply=await this.client.sessions({action:'abandon',requestId:request.requestId},{signal}) as {ok?:boolean;action?:string;status?:string;requestId?:string;message?:string};
    if(reply?.ok!==true||reply.action!=='abandon'||reply.status!=='abandoned'||reply.requestId!==request.requestId)throw new KnownToolError(reply?.message??'未确认原请求已放弃，不能重新申请。');
    this.unresolved.delete(signature);
  }
  needsDispatch(cardId:string,projectId:string){return [...this.unresolved.values()].some(request=>request.cardId===cardId&&request.projectId===projectId&&!request.dispatched);}
  async create(args:{cardId:string;projectId:string;name:string},options:{signal?:AbortSignal;onPhase?:(phase:SessionPhase)=>void}={}):Promise<SessionReply>{
    const {signal,onPhase}=options;signal?.throwIfAborted();
    const prior=[...this.unresolved.entries()].find(([,request])=>request.cardId===args.cardId&&request.projectId===args.projectId);
    const signature=prior?.[0]??JSON.stringify([args.cardId,args.projectId,args.name]);
    const request=prior?.[1]??{requestId:crypto.randomUUID(),cardId:args.cardId,projectId:args.projectId,dispatched:false,acknowledged:false};
    this.unresolved.set(signature,request);
    if(!request.prepared){
      onPhase?.('preparing');
      try{request.prepared=sessionReply('create',await this.client.sessions({action:'create',...args,requestId:request.requestId},{signal}));}
      catch(error){if(error instanceof KnownToolError&&error.code!=='PROJECT_AMBIGUOUS')this.unresolved.delete(signature);throw error;}
    }
    signal?.throwIfAborted();
    if(request.prepared.status==='expired'){const reply=request.prepared;request.expired=true;request.dispatched=true;request.prepared={...reply,status:'pending',resume:true};throw new KnownToolError(`请求过期，可能已有会话。请先核对现有会话。${reply.message??''}`,reply.state);}
    if(request.prepared.status==='failed'){this.unresolved.delete(signature);throw new KnownToolError(request.prepared.message??'会话创建失败。',request.prepared.state);}
    if(request.prepared.status!=='pending'){this.unresolved.delete(signature);return request.prepared;}
    if(request.prepared.requestId!==request.requestId)throw new Error('创建请求编号不一致，已停止发送。');
    if(request.prepared.resume===true)request.dispatched=true;
    if(!request.dispatched){
      onPhase?.('sending');
      if(!this.client.sendHostMessage)throw new KnownToolError('当前宿主不支持发送消息，创建请求尚未提交。');
      request.dispatched=true;
      try{await this.client.sendHostMessage(request.prepared.prompt!,signal);request.acknowledged=true;}
      catch(error){if(error instanceof KnownToolError)request.dispatched=false;throw error;}
    }
    signal?.throwIfAborted();onPhase?.(request.acknowledged?'waiting':'checking');
    const limit=new AbortController();
    const timeout=setTimeout(()=>limit.abort(new Error('等待已达上限。请求可能仍在处理，重试将继续查询原请求。')),this.timing.maxWaitMs);
    const pollSignal=signal?AbortSignal.any([signal,limit.signal]):limit.signal;
    try{
      while(true){
        await wait(this.timing.intervalMs,pollSignal);
        const reply=sessionStatusReply(await this.client.sessions({action:'status',requestId:request.requestId},{signal:pollSignal}));
        pollSignal.throwIfAborted();
        if(reply.status==='complete'){this.unresolved.delete(signature);return {ok:true,action:'create',status:'complete',sessionId:reply.sessionId,state:reply.state};}
        if(reply.status==='expired'){request.expired=true;request.dispatched=true;throw new KnownToolError(`请求过期，可能已有会话。请先核对现有会话。${reply.message??''}`,reply.state);}
        if(reply.status==='failed'){this.unresolved.delete(signature);throw new KnownToolError(reply.message??'会话创建失败。',reply.state);}
      }
    }finally{clearTimeout(timeout);}
  }
}
