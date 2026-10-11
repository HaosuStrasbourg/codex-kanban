import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import { HostClient, ReliableMutations, unwrapToolResult } from './client.ts';
import { safeExternalLink } from './view-model.ts';
import { ProjectStore } from '../../core/src/index.ts';

const transportHarness=vi.hoisted(()=>({instances:[] as {close:ReturnType<typeof vi.fn>;onclose?:()=>void}[],modes:[] as ('success'|'fail'|'pending')[]}));
vi.mock('@modelcontextprotocol/ext-apps',async importOriginal=>{
  const actual=await importOriginal<typeof import('@modelcontextprotocol/ext-apps')>();
  return {...actual,PostMessageTransport:class {
    onmessage?: (message:unknown)=>void;
    onclose?:()=>void;
    close=vi.fn(async()=>{this.onclose?.();});
    constructor(){transportHarness.instances.push(this);}
    async start(){}
    async send(message:{id?:number;method?:string;params?:{protocolVersion?:string}}){
      if(message.method!=='ui/initialize')return;
      const mode=transportHarness.modes.shift()??'success';
      if(mode==='pending')return;
      queueMicrotask(()=>this.onmessage?.({jsonrpc:'2.0',id:message.id,...(mode==='fail'
        ?{error:{code:-32000,message:'合成握手失败'}}
        :{result:{protocolVersion:message.params?.protocolVersion,hostInfo:{name:'合成宿主',version:'1'},hostCapabilities:{},hostContext:{}}})}));
    }
  }};
});

describe('C-688 直接打开会话：真实SDK入口，不发聊天指令',()=>{
  let client:HostClient;
  const target='00000000-0000-4000-8000-000000000001';
  beforeEach(()=>{vi.stubGlobal('window',{parent:{},dispatchEvent:vi.fn()});client=new HostClient();vi.spyOn(McpApp.prototype,'getHostCapabilities').mockReturnValue({openLinks:{}});});
  afterEach(()=>{client.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
  function reply(value:unknown){return vi.spyOn(McpApp.prototype,'callServerTool').mockResolvedValue({content:[],structuredContent:value as Record<string,unknown>});}
  it('C-688 验证目标后直接openLink，零sendMessage',async()=>{
    reply({ok:true,action:'open',status:'ready',sessionId:target});
    const open=vi.spyOn(McpApp.prototype,'openLink').mockResolvedValue({});const message=vi.spyOn(McpApp.prototype,'sendMessage');
    await expect(client.sessions({action:'open',projectId:'p',sessionId:target})).resolves.toMatchObject({ok:true,status:'complete',sessionId:target});
    expect(open).toHaveBeenCalledExactlyOnceWith({url:`codex://threads/${target}`},expect.objectContaining({timeout:10000}));expect(message).not.toHaveBeenCalled();
  });
  it('C-688 旧服务dispatch回复也直接导航，不转发其中prompt',async()=>{
    reply({ok:true,action:'open',status:'dispatch',sessionId:target,prompt:'不得被发送的旧导航指令'});
    const open=vi.spyOn(McpApp.prototype,'openLink').mockResolvedValue({});const message=vi.spyOn(McpApp.prototype,'sendMessage');
    const result=await client.sessions({action:'open',sessionId:target});expect(result).toMatchObject({status:'complete'});expect(result).not.toHaveProperty('prompt');expect(open).toHaveBeenCalledTimes(1);expect(message).not.toHaveBeenCalled();
  });
  it.each([{ok:true,action:'open',sessionId:'other'},{ok:false,action:'open',sessionId:target},{}])('C-688 错误或不匹配目标拒绝导航：%j',async value=>{
    reply(value);const open=vi.spyOn(McpApp.prototype,'openLink');const message=vi.spyOn(McpApp.prototype,'sendMessage');
    await expect(client.sessions({action:'open',sessionId:target})).rejects.toThrow();expect(open).not.toHaveBeenCalled();expect(message).not.toHaveBeenCalled();
  });
  it.each([{isError:true},undefined])('C-688 宿主拒绝或未确认不能报成功，也不回退聊天：%j',async value=>{
    reply({ok:true,action:'open',status:'ready',sessionId:target});vi.spyOn(McpApp.prototype,'openLink').mockResolvedValue(value as any);const message=vi.spyOn(McpApp.prototype,'sendMessage');
    await expect(client.sessions({action:'open',sessionId:target})).rejects.toThrow();expect(message).not.toHaveBeenCalled();
  });
  it('C-688 宿主不支持openLinks时明确失败，不发消息',async()=>{
    reply({ok:true,action:'open',status:'ready',sessionId:target});vi.mocked(McpApp.prototype.getHostCapabilities).mockReturnValue({});const open=vi.spyOn(McpApp.prototype,'openLink');const message=vi.spyOn(McpApp.prototype,'sendMessage');
    await expect(client.sessions({action:'open',sessionId:target})).rejects.toThrow('直接');expect(open).not.toHaveBeenCalled();expect(message).not.toHaveBeenCalled();
  });
});

describe('C-241 连接恢复局部：真实SDK握手与合成传输，不计原生宿主通过',()=>{
  let stopResize:ReturnType<typeof vi.fn<()=>void>>;
  let setupResize:ReturnType<typeof vi.spyOn>;
  let client:HostClient;
  beforeEach(()=>{
    transportHarness.instances=[];transportHarness.modes=[];
    vi.stubGlobal('window',{parent:{},dispatchEvent:vi.fn()});
    stopResize=vi.fn<()=>void>();setupResize=vi.spyOn(McpApp.prototype,'setupSizeChangedNotifications').mockReturnValue(stopResize);
    client=new HostClient();
  });
  afterEach(()=>{client.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
  it('C-241 首次快照失败后重新连接复用有效握手，恢复读取且只清理原连接',async()=>{
    const snapshot={state:{revision:3}};
    vi.spyOn(McpApp.prototype,'callServerTool').mockRejectedValueOnce(new Error('合成快照暂不可用')).mockResolvedValueOnce({content:[],structuredContent:snapshot});
    await client.connect();
    await expect(client.snapshot()).rejects.toThrow('合成快照暂不可用');
    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.snapshot()).resolves.toEqual(snapshot);
    expect(transportHarness.instances).toHaveLength(1);expect(setupResize).toHaveBeenCalledTimes(1);
    client.close();client.close();
    expect(stopResize).toHaveBeenCalledTimes(1);expect(transportHarness.instances[0]!.close).toHaveBeenCalledTimes(1);
  });
  it('C-241 并发重连只握手一次，握手失败后可用新连接重试',async()=>{
    transportHarness.modes.push('fail','success');
    await expect(client.connect()).rejects.toThrow('合成握手失败');
    await expect(Promise.all([client.connect(),client.connect()])).resolves.toEqual([undefined,undefined]);
    expect(transportHarness.instances).toHaveLength(2);expect(setupResize).toHaveBeenCalledTimes(1);
    expect(transportHarness.instances[0]!.close).toHaveBeenCalledTimes(1);
  });
  it('C-241 连接中关闭会终止旧握手且不启动监听，之后可重新打开',async()=>{
    transportHarness.modes.push('pending','success');
    const pending=client.connect();
    const rejected=expect(pending).rejects.toThrow('Connection closed');
    await Promise.resolve();await Promise.resolve();
    client.close();await rejected;
    expect(setupResize).not.toHaveBeenCalled();
    await client.connect();expect(setupResize).toHaveBeenCalledTimes(1);
  });
});

describe('UI 传输和内容防护（本地单元，不计真实宿主通过）',()=>{
  it('C-227 界面局部：会话接口错误不包装成打开成功',()=>{
    expect(()=>unwrapToolResult({isError:true,content:[{type:'text',text:JSON.stringify({error:'Codex 桌面会话桥接尚未接通'})}]})).toThrow('会话桥接尚未接通');
  });
  it('C-225 界面局部：标准工具响应可恢复结构化偏好',()=>{
    expect(unwrapToolResult({structuredContent:{state:{preferences:{ui:{view:'全部'}}}},content:[]})).toMatchObject({state:{preferences:{ui:{view:'全部'}}}});
    expect(unwrapToolResult({content:[{type:'text',text:'{"state":{"revision":2}}'}]})).toMatchObject({state:{revision:2}});
  });
  it('UI-SAFE 额外防护：成果内容不能成为可执行链接（不计黄金用例）',()=>{
    expect(safeExternalLink('javascript:alert(1)')).toBeNull();
    expect(safeExternalLink('data:text/html,<script>')).toBeNull();
    expect(safeExternalLink('/tmp/result.md')).toBeNull();
    expect(safeExternalLink('https://example.com/result')).toBe('https://example.com/result');
  });
  it('C-183 UI重试局部：SQLite已接受建卡但响应丢失，同表单重试只创建一张，明确结果后允许再建同内容',async()=>{
    const store=new ProjectStore(':memory:');
    try {
      store.applyEvent({id:'seed-project',type:'project.upsert',actor:{kind:'user'},payload:{id:'p',name:'测试项目',folder:'/tmp/kanban-ui-idempotency'}});
      let loseResponse=true;const ids:string[]=[];
      const client={apply:async(event:import('./client.ts').UIEvent)=>{
        ids.push(event.id);const result=store.applyEvent({...event,actor:{kind:'user'}});
        if(loseResponse){loseResponse=false;throw new Error('响应在写入成功后丢失');}
        return {result,state:store.getState()};
      }};
      const reliable=new ReliableMutations(client);
      const mutation={type:'card.create' as const,projectId:'p',payload:{title:'同一个表单'}};
      await expect(reliable.apply(mutation)).rejects.toThrow('响应在写入成功后丢失');
      expect(store.getState().cards).toHaveLength(1);
      const retry=await reliable.apply(mutation);
      expect(retry.result.status).toBe('duplicate');
      expect(ids[1]).toBe(ids[0]);expect(store.getState().cards).toHaveLength(1);
      await reliable.apply(mutation);
      expect(ids[2]).not.toBe(ids[0]);expect(store.getState().cards).toHaveLength(2);
    }finally{store.close();}
  });
  it('C-241 UI重试局部：isError携带领域拒绝和有效快照时保留上下文，明确拒绝后使用新操作ID',async()=>{
    const state={revision:1};
    const response={result:{ok:false,status:'rejected',errors:['缺少标题'],warnings:[]},state};
    expect(unwrapToolResult({isError:true,structuredContent:response})).toEqual(response);
    const ids:string[]=[];
    const reliable=new ReliableMutations({apply:async(event)=>{ids.push(event.id);return unwrapToolResult({isError:true,structuredContent:response});}});
    const mutation={type:'card.create' as const,projectId:'p',payload:{title:''}};
    await reliable.apply(mutation);await reliable.apply(mutation);
    expect(ids[1]).not.toBe(ids[0]);
  });
});

it('C-123 项目歧义局部：工具错误保留候选项目供真人选择',()=>{
  try{unwrapToolResult({isError:true,structuredContent:{code:'PROJECT_AMBIGUOUS',message:'请选择所属项目',projectCandidates:[{id:'host-a',name:'工作项目'}]}});throw new Error('应抛出明确错误');}
  catch(error){expect(error).toMatchObject({message:'请选择所属项目',code:'PROJECT_AMBIGUOUS',projectCandidates:[{id:'host-a',name:'工作项目'}]});}
});
