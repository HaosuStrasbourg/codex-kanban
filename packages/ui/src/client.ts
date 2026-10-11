import { App as McpApp, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import type { Event, Result, State } from '../../core/src/types.ts';
export type UIEvent = Omit<Event,'actor'|'at'|'turnId'>;
export interface Capabilities {sessions:{list:boolean;create:boolean;open:boolean;reason?:string};automaticSync?:{configuredProjectIds:string[];state:'disabled'|'configured';message:string};appOnlyEnforcement?:string;threadIdentity?:string}
export interface PendingSessionRequest {requestId:string;projectId:string;cardId:string;name?:string;status:'pending'|'claiming'|'expired';targetId?:string;issuedAt:number;expiresAt:number}
export interface Snapshot {state:State;capabilities:Capabilities;currentProjectId?:string;sessionRequests?:PendingSessionRequest[];projectDiscovery?:{status:'available'|'unavailable'|'refreshing';message?:string;currentFolder?:string;currentProjectId?:string}}
export interface ApplyResponse {result:Result;state:State}
export interface ToolErrorDetails {code?:string;projectCandidates?:{id:string;name:string}[]}
export class KnownToolError extends Error {
  readonly code?:string;readonly projectCandidates?:{id:string;name:string}[];
  constructor(message:string,readonly state?:State,details?:ToolErrorDetails){super(message);this.name='KnownToolError';this.code=details?.code;this.projectCandidates=Array.isArray(details?.projectCandidates)?details.projectCandidates.filter(candidate=>typeof candidate?.id==='string'&&typeof candidate.name==='string'):undefined;}
}
export interface Client {readonly preview:boolean;connect():Promise<void>;snapshot(options?:{refreshProjects?:boolean}):Promise<Snapshot>;apply(event:UIEvent):Promise<ApplyResponse>;sessions(args:Record<string,unknown>,options?:{signal?:AbortSignal}):Promise<unknown>;sendHostMessage(prompt:string,signal?:AbortSignal):Promise<void>;fullscreen():Promise<boolean>;canFullscreen():boolean;close():void}
export function unwrapToolResult<T>(value:unknown):T {
  const result=value as {isError?:boolean;structuredContent?:unknown;content?:{type:string;text?:string}[]};
  let data=result?.structuredContent;
  const body=result?.content?.find(x=>x.type==='text')?.text;
  if(data===undefined&&body){try{data=JSON.parse(body);}catch{data={error:body};}}
  if(result?.isError&&!(data&&typeof data==='object'&&'result' in data&&'state' in data)){const d=data as ({error?:string;message?:string;state?:State}&ToolErrorDetails)|undefined;throw new KnownToolError(d?.error??d?.message??body??'插件操作失败',d?.state,d);}
  return (data??value) as T;
}
/** Keep the id only while the outcome is unknown; confirmed results release it. */
export class ReliableMutations {
  private unresolved=new Map<string,UIEvent>();
  constructor(private client:Pick<Client,'apply'>){}
  async apply(mutation:Omit<UIEvent,'id'>):Promise<ApplyResponse>{
    const signature=JSON.stringify(mutation,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
    const event=this.unresolved.get(signature)??{...mutation,id:crypto.randomUUID()};
    this.unresolved.set(signature,event);
    const reply=await this.client.apply(event);
    if(!reply?.result||typeof reply.result.ok!=='boolean'||!reply.state)throw new Error('未收到明确的保存结果，请使用原表单重试。');
    this.unresolved.delete(signature);
    return reply;
  }
}
export class HostClient implements Client {
  readonly preview=false;
  private app=new McpApp({name:'Codex 项目管理',version:'0.2.0'},{availableDisplayModes:['inline','fullscreen']},{autoResize:false});
  private transport:PostMessageTransport|undefined;
  private stopResize:(()=>void)|undefined;
  private connected=false;
  private connection:Promise<void>|undefined;
  constructor(){
    this.app.onteardown=async()=>{this.stopResize?.();this.stopResize=undefined;window.dispatchEvent(new Event('kanban:teardown'));return {};};
  }
  async connect(){
    // A failed tool call does not invalidate a successful host handshake.
    if(this.connected)return;
    if(this.connection)return this.connection;
    const transport=new PostMessageTransport(window.parent,window.parent);
    this.transport=transport;
    transport.onclose=()=>{
      if(this.transport!==transport)return;
      this.connected=false;this.transport=undefined;this.stopResize?.();this.stopResize=undefined;
    };
    const attempt=(async()=>{
      try{
        await this.app.connect(transport,{timeout:8000});
        if(this.transport!==transport)throw new Error('连接已关闭，请重新连接。');
        this.connected=true;this.stopResize=this.app.setupSizeChangedNotifications();
      }catch(error){
        if(this.transport===transport){await transport.close();this.connected=false;this.transport=undefined;}
        throw error;
      }
    })();
    this.connection=attempt;
    try{await attempt;}finally{if(this.connection===attempt)this.connection=undefined;}
  }
  async snapshot(options?:{refreshProjects?:boolean}){return unwrapToolResult<Snapshot>(await this.app.callServerTool({name:'cpm_snapshot',arguments:options?.refreshProjects?{refreshProjects:true}:{}}, {timeout:8000}));}
  async apply(event:UIEvent){return unwrapToolResult<ApplyResponse>(await this.app.callServerTool({name:'cpm_apply',arguments:{event}},{timeout:event.type==='card.create'?25000:10000}));}
  async sessions(args:Record<string,unknown>,options?:{signal?:AbortSignal}){
    const reply=unwrapToolResult<Record<string,unknown>>(await this.app.callServerTool({name:'cpm_sessions',arguments:args},{timeout:25000,signal:options?.signal}));
    if(args.action!=='open')return reply;
    const sessionId=args.sessionId;
    if(!reply||reply.ok!==true||reply.action!=='open'||typeof sessionId!=='string'||!sessionId||reply.sessionId!==sessionId)
      throw new KnownToolError('返回的会话与所选会话不一致或未通过验证，尚未打开。');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
      throw new KnownToolError('目标会话编号无效，尚未打开。');
    if(!this.app.getHostCapabilities()?.openLinks)throw new KnownToolError('当前 Codex 不支持直接打开会话，请更新 Codex 后重试。');
    options?.signal?.throwIfAborted();
    // Older servers return a dispatch prompt. Navigation never sends that prompt to a chat.
    const opened=await this.app.openLink({url:`codex://threads/${encodeURIComponent(sessionId)}`},{timeout:10000,signal:options?.signal});
    if(!opened||typeof opened!=='object'||opened.isError)throw new KnownToolError('Codex 未确认打开会话，请重试。');
    return {ok:true,action:'open',status:'complete',sessionId};
  }
  async sendHostMessage(prompt:string,signal?:AbortSignal){
    if(typeof this.app.sendMessage!=='function')throw new KnownToolError('当前 Codex 宿主不支持发送消息。');
    const result=await this.app.sendMessage({role:'user',content:[{type:'text',text:prompt}]},{timeout:10000,signal});
    if(result?.isError)throw new KnownToolError('Codex 未接受会话请求消息，请重试。');
    if(!result||typeof result!=='object')throw new Error('未收到 Codex 的消息确认，请重试核对。');
  }
  canFullscreen(){return this.app.getHostContext()?.availableDisplayModes?.includes('fullscreen')??false;}
  async fullscreen(){return (await this.app.requestDisplayMode({mode:'fullscreen'})).mode==='fullscreen';}
  close(){
    this.connected=false;this.stopResize?.();this.stopResize=undefined;
    const transport=this.transport;this.transport=undefined;void transport?.close();
  }
}
/** The preview API must be backed by an isolated real ProjectStore, never production data. */
export class PreviewClient implements Client {
  readonly preview=true;
  async connect(){}
  private async request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
    const response=await fetch('/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,credentials:'omit',signal});
    const data=await response.json();
    if(!response.ok)throw new KnownToolError(data.error??data.message??'本地验收服务不可用',data.state,data);
    return data as T;
  }
  snapshot(options?:{refreshProjects?:boolean}){return this.request<Snapshot>(options?.refreshProjects?'snapshot?refreshProjects=true':'snapshot');}
  apply(event:UIEvent){return this.request<ApplyResponse>('apply',{event});}
  sessions(args:Record<string,unknown>,options?:{signal?:AbortSignal}){return this.request('sessions',args,options?.signal);}
  async sendHostMessage(_prompt:string,_signal?:AbortSignal):Promise<void>{throw new KnownToolError('本地预览无法向真实 Codex 发送会话请求。');}
  canFullscreen(){return false;}
  async fullscreen(){return false;}
  close(){}
}
