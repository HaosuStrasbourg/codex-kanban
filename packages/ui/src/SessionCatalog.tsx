import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import type {Card,Session,State} from '../../core/src/types.ts';
import {KnownToolError} from './client.ts';
import type {Capabilities,Client} from './client.ts';
import {selectProjectSessions} from './session-catalog.ts';
import type {SessionLinkFilter} from './session-catalog.ts';
import {sessionReply} from './session-ui.ts';
import {timeLabel} from './view-model.ts';

interface Props {
  state:State;projectIds:string[]|'all';caps:Capabilities;client:Client;
  onState:(state:State)=>void;onBind:(session:Session)=>void;onNewCard:(session:Session)=>void;onCard:(card:Card)=>void;
  onAmbiguous:(projectId:string,candidates:{id:string;name:string}[],retry:()=>void)=>void;
  renderSync:(card:Card,session:Session)=>ReactNode;
}
export function SessionCatalog({state,projectIds,caps,client,onState,onBind,onNewCard,onCard,onAmbiguous,renderSync}:Props){
  const [query,setQuery]=useState('');const [link,setLink]=useState<SessionLinkFilter>('all');
  const [busy,setBusy]=useState('');const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const active=useRef<AbortController|null>(null);const alive=useRef(true);
  const scopeKey=projectIds==='all'?'all':projectIds.join('|');
  useEffect(()=>{alive.current=true;const stop=()=>active.current?.abort();window.addEventListener('pagehide',stop);window.addEventListener('kanban:teardown',stop);return()=>{alive.current=false;stop();window.removeEventListener('pagehide',stop);window.removeEventListener('kanban:teardown',stop);};},[]);
  useEffect(()=>{active.current?.abort();active.current=null;setBusy('');setError('');setNotice('');},[scopeKey]);
  const sessions=selectProjectSessions(state.sessions,projectIds,query,link);
  const projects=state.projects.filter(project=>projectIds==='all'||projectIds.includes(project.id));
  const multiple=projects.length>1;
  const fail=(e:unknown,projectId:string,retry:()=>void)=>{
    if(e instanceof KnownToolError&&e.code==='PROJECT_AMBIGUOUS'&&e.projectCandidates?.length){setError('这个目录关联了多个 Codex 项目，选择所属项目后再继续。已登记会话保留。');onAmbiguous(projectId,e.projectCandidates,retry);return true;}
    return false;
  };
  const refreshSessions=async()=>{
    if(active.current||!caps.sessions.list)return;
    const controller=new AbortController();active.current=controller;setBusy('refresh');setError('');setNotice('');
    const failures:string[]=[];const notes:string[]=[];
    try{
      for(const project of projects){
        try{
          const reply=sessionReply('list',await client.sessions({action:'list',projectId:project.id},{signal:controller.signal}));
          controller.signal.throwIfAborted();
          if(reply.message)notes.push(reply.message);else if(reply.warnings)notes.push(...reply.warnings);
          const snapshot=reply.state??(await client.snapshot()).state;
          if(alive.current)onState(snapshot);
        }catch(e){
          if(controller.signal.aborted)return;
          if(fail(e,project.id,()=>void refreshSessions()))return;
          failures.push(`${project.name}：${String((e as Error).message??e)}`);
        }
      }
      if(alive.current){if(failures.length)setError(`刷新失败，保留已登记会话。${failures.join('；')}`);setNotice(notes.length?[...new Set(notes)].join('；'):failures.length?'':'会话列表已刷新。未在本次返回的已登记会话仍保留。');}
    }finally{if(active.current===controller){active.current=null;if(alive.current)setBusy('');}}
  };
  const open=async(session:Session)=>{
    if(active.current||!caps.sessions.open)return;
    const controller=new AbortController();active.current=controller;setBusy(session.id);setError('');setNotice('');
    try{
      const reply=sessionReply('open',await client.sessions({action:'open',projectId:session.projectId,sessionId:session.id},{signal:controller.signal}));
      controller.signal.throwIfAborted();
      if(reply.sessionId!==session.id)throw new KnownToolError('返回的会话与所选会话不一致，尚未打开。');
      if(alive.current)setNotice('已请求 Codex 打开会话。');
    }catch(e){if(!controller.signal.aborted&&alive.current&&!fail(e,session.projectId,()=>void open(session)))setError(`打开会话失败：${String((e as Error).message??e)}`);}
    finally{if(active.current===controller){active.current=null;if(alive.current)setBusy('');}}
  };
  return <section className="session-catalog" aria-label="项目会话">
    <div className="session-catalog-heading"><div><h1>会话</h1><p>已有讨论可以先留在这里，需要推进时再关联卡片。</p></div><button className="button" disabled={!!busy||!caps.sessions.list||!projects.length} onClick={()=>void refreshSessions()}>{busy==='refresh'?'刷新中…':'刷新会话'}</button></div>
    <div className="session-catalog-filters"><label><span>名称搜索</span><input type="search" aria-label="搜索会话名称" placeholder="搜索会话名称" value={query} onChange={event=>setQuery(event.target.value)}/></label><label><span>关联状态</span><select aria-label="会话关联状态" value={link} onChange={event=>setLink(event.target.value as SessionLinkFilter)}><option value="all">全部会话</option><option value="unbound">未关联</option><option value="bound">已关联</option></select></label></div>
    <div className="session-catalog-meta"><span>{sessions.length} 个会话</span><span>最近活动在前</span></div>
    {error&&<p className="session-catalog-error" role="alert">{error}</p>}{notice&&<p className="session-catalog-notice" role="status">{notice}</p>}
    {(!caps.sessions.open||!caps.sessions.list)&&<p className="help">{caps.sessions.reason??'Codex 会话操作尚未接通；仍可查看已登记会话并关联卡片。'}</p>}
    {!sessions.length?<div className="session-catalog-empty"><h2>{query||link!=='all'?'没有匹配的会话':'这里还没有已登记会话'}</h2><p>{query||link!=='all'?'调整名称或关联状态筛选。':projects.length?'点击“刷新会话”读取所选项目的已有会话。会话不会自动生成卡片。':'请先选择一个项目。'}</p></div>:<div className="session-catalog-list">{sessions.map(session=>{
      const card=state.cards.find(card=>card.id===session.cardId&&!card.deleted);const pending=state.cards.find(card=>card.id===session.pendingCardId&&!card.deleted);
      return <article className="session-row" key={session.id} data-session-id={session.id}>
        <div className="session-row-title"><span className={`session-dot ${session.status==='运行中'?'running':''}`}/><h2>{session.name}</h2></div>
        <div className="session-row-meta">{multiple&&<span>{state.projects.find(project=>project.id===session.projectId)?.name??'未登记项目'}</span>}<time dateTime={session.lastActivityAt}>{timeLabel(session.lastActivityAt)}</time><span>{session.status}</span></div>
        <div className="session-row-binding">{card?<button className="session-card-link" onClick={()=>onCard(card)}>已关联 #{card.no} {card.title}{card.archived?' · 已归档':''}</button>:<span>{session.cardId?'原关联卡片不可用':'未关联卡片'}</span>}{pending&&<span>本轮结束后关联 #{pending.no} {pending.title}</span>}</div>
        {(pending??card)&&renderSync((pending??card)!,session)}
        <div className="session-row-actions"><button className="button" disabled={!!busy||!caps.sessions.open} onClick={()=>void open(session)}>{busy===session.id?'正在请求…':'打开会话'}</button><button className="text-button" disabled={!!busy} onClick={()=>onBind(session)}>关联卡片</button><button className="text-button" disabled={!!busy} onClick={()=>onNewCard(session)}>新建卡片并关联</button></div>
      </article>;
    })}</div>}
  </section>;
}
