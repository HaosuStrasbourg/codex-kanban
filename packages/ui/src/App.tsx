import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement, ReactNode } from 'react';
import type { Activity, Card, ChecklistItem, EventType, Notification, Session, State, Status } from '../../core/src/types.ts';
import { KnownToolError, ReliableMutations } from './client.ts';
import type { Client, Capabilities, PendingSessionRequest, Snapshot } from './client.ts';
import { STATUSES, VIEWS, completionRisks, defaultPreferences, followUpInput, followUpValue, groupCards, nextStatus, pointerOutsideBoard, presentActivity, restoredPreferences, safeExternalLink, selectCards, timeLabel } from './view-model.ts';
import type { Preferences } from './view-model.ts';
import { ReliableSessionCreates, sessionNamePreview, sessionReply, visibleSessions } from './session-ui.ts';
import type { SessionAction, SessionPhase } from './session-ui.ts';
import {SessionCatalog} from './SessionCatalog.tsx';
import {KanbanLogo} from './KanbanLogo.tsx';
import {SessionCardDrafts,sessionCardChoices} from './session-catalog.ts';
import {ReliableProgressSync,progressSyncEvidence,syncKey} from './automatic-sync.ts';
import type {SyncNotice} from './automatic-sync.ts';
import {businessDate} from '../../core/src/dates.ts';

type Modal = {kind:'project'} | {kind:'create'} | {kind:'edit';card:Card} | {kind:'complete';card:Card}
  | {kind:'item';card:Card;list:'checklist'|'acceptance'|'blockers';item?:ChecklistItem}
  | {kind:'evidence';card:Card;item:ChecklistItem} | {kind:'resolve';card:Card;item:ChecklistItem}
  | {kind:'artifact';card:Card} | {kind:'sessions';card:Card;sessions:Session[];loading?:boolean;loadError?:string}
  | {kind:'rebind';card:Card;session:Session} | {kind:'createSession';card:Card;name?:string}
  | {kind:'projectChoice';card:Card;action:SessionAction;extra:Record<string,unknown>;candidates:{id:string;name:string}[]}
  | {kind:'selectCard';session:Session} | {kind:'sessionCard';session:Session}
  | {kind:'catalogProjectChoice';projectId:string;candidates:{id:string;name:string}[];retry:()=>void}
  | {kind:'delete';card:Card};
type Mutation = {type:EventType;projectId?:string;cardId?:string;sessionId?:string;payload:Record<string,unknown>};
type DetailTextField='progressText'|'nextStep'|'description';
type DetailTextDraft={initial:string;value:string;error:string};
type PlanningValues={priority:Card['priority'];followUpOwner:string;dueDate:string;followUpAt:string;tags:string};
type PlanningDraft={initial:Pick<Card,'priority'|'followUpOwner'|'dueDate'|'followUpAt'|'tags'>;values:PlanningValues;error:string};
const planningValues=(card:PlanningDraft['initial']):PlanningValues=>({priority:card.priority,followUpOwner:card.followUpOwner??'',dueDate:card.dueDate??'',followUpAt:followUpInput(card.followUpAt),tags:card.tags.join('，')});
const COLUMN_LABELS:Record<string,string>={status:'状态',priority:'优先级',dueDate:'计划交付日',followUpOwner:'跟进人',followUpAt:'跟进时间（北京时间）',progress:'验收进度',tags:'标签',nextStep:'下一步'};
const SOURCE_LABELS={user:'我',assistant:'AI 代办',session:'会话',user_instruction:'我的对话指令',system:'系统'};
const DESCRIPTION='目标\n\n范围（做什么、不做什么）\n\n资料\n\n备注\n';
function Field({label,children}:{label:string;children:ReactNode}){return <label className="field"><span>{label}</span>{isValidElement(children)?cloneElement(children as ReactElement<{'aria-label'?:string}>,{'aria-label':label}):children}</label>;}
function FollowUpFields({card,disabled=false}:{card?:Partial<Card>;disabled?:boolean}){return <div className="follow-up-fields"><Field label="跟进人"><input name="followUpOwner" defaultValue={card?card.followUpOwner??'':'我'} disabled={disabled} placeholder="例如：我、同事姓名"/></Field><Field label="跟进时间（北京时间）"><input name="followUpAt" type="datetime-local" step="60" defaultValue={followUpInput(card?.followUpAt)} disabled={disabled}/></Field></div>;}
function Empty({title,body,children}:{title:string;body:string;children?:ReactNode}){return <div className="empty"><span className="empty-mark" aria-hidden="true">◇</span><h3>{title}</h3><p>{body}</p>{children}</div>;}
function value(form:FormData,key:string){return String(form.get(key)??'').trim();}
function formValues(form:HTMLFormElement){return JSON.stringify(Array.from(form.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('[name]')).map(input=>[input.name,input instanceof HTMLInputElement&&input.type==='checkbox'?input.checked:input.value]));}
function TableFieldEditor({label,value,type='text',multiline=false,onSave,onDone,onEditingChange,autoFocus=false}:{label:string;value:string;type?:string;multiline?:boolean;onSave:(value:string)=>Promise<boolean>;onDone?:()=>void;onEditingChange?:(editing:boolean)=>void;autoFocus?:boolean}){
  const [draft,setDraft]=useState<{initial:string;value:string}|null>(null);
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);const saving=useRef(false);const cancelBlur=useRef(false);
  const save=async()=>{
    if(cancelBlur.current){cancelBlur.current=false;return;}
    if(!draft||saving.current)return;
    if(draft.value===draft.initial){setDraft(null);setError('');onEditingChange?.(false);onDone?.();return;}
    saving.current=true;setBusy(true);setError('');
    try{if(await onSave(draft.value)){setDraft(null);onEditingChange?.(false);onDone?.();}else setError('保存失败，草稿已保留。');}
    catch(e){setError(`${String((e as Error).message)} 草稿已保留。`);}
    finally{saving.current=false;setBusy(false);}
  };
  const props={'aria-label':label,autoFocus,value:draft?.value??value,disabled:busy,onFocus:()=>{if(!draft){setDraft({initial:value,value});onEditingChange?.(true);}},onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>{const next=event.target.value;setDraft(current=>({initial:current?.initial??value,value:next}));},onBlur:()=>void save(),onKeyDown:(event:React.KeyboardEvent<HTMLInputElement|HTMLTextAreaElement>)=>{if(event.nativeEvent.isComposing)return;if(event.key==='Escape'){event.preventDefault();cancelBlur.current=true;setDraft(null);setError('');event.currentTarget.blur();onEditingChange?.(false);onDone?.();}else if(event.key==='Enter'&&(!multiline||event.ctrlKey||event.metaKey)){event.preventDefault();event.currentTarget.blur();}}};
  return <div className="table-field-editor">{multiline?<textarea {...props} rows={2}/>:<input {...props} type={type} step={type==='datetime-local'?'60':undefined}/>} {error&&<div className="table-field-error" role="alert"><span>{error}</span><button type="button" className="text-button" disabled={busy} aria-label={`重试保存${label.replace(/^卡片 #\d+ /,'')}`} onMouseDown={event=>event.preventDefault()} onClick={()=>void save()}>重试保存</button><button type="button" className="text-button" onMouseDown={event=>event.preventDefault()} onClick={()=>{setDraft(null);setError('');onEditingChange?.(false);onDone?.();}}>放弃修改</button></div>}</div>;
}

export function App({client}:{client:Client}) {
  const [area,setArea]=useState<'tasks'|'sessions'>('tasks');
  const [state,setState]=useState<State|null>(null);
  const stateRef=useRef<State|null>(null);stateRef.current=state;
  const [restoredSnapshot,setRestoredSnapshot]=useState<Snapshot|null>(null);const restorePending=useRef(false);
  const snapshotRequest=useRef(0);const snapshotGeneration=useRef(0);const mutationGeneration=useRef(0);
  const [baselineGeneration,setBaselineGeneration]=useState(0);const [tableDraftGeneration,setTableDraftGeneration]=useState(0);
  const [projectDiscovery,setProjectDiscovery]=useState<Snapshot['projectDiscovery']>();
  const [caps,setCaps]=useState<Capabilities>({sessions:{list:false,create:false,open:false,reason:'尚未连接'}});
  const [prefs,setPrefs]=useState<Preferences>({...defaultPreferences});
  const [selected,setSelected]=useState<string|null>(null);
  const [detailDrafts,setDetailDrafts]=useState<Partial<Record<DetailTextField,DetailTextDraft>>>({});
  const [planningDraft,setPlanningDraft]=useState<PlanningDraft|null>(null);
  const [detailClosePrompt,setDetailClosePrompt]=useState(false);
  const [modal,setModal]=useState<Modal|null>(null);
  const [modalClosePrompt,setModalClosePrompt]=useState(false);
  const modalForm=useRef<HTMLFormElement|null>(null);const modalInitial=useRef('');const lastModalForm=useRef<HTMLFormElement|null>(null);
  const [operationError,setOperationError]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [saving,setSaving]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [projectMenu,setProjectMenu]=useState(false);
  const [filtersOpen,setFiltersOpen]=useState(false);
  const [columnsOpen,setColumnsOpen]=useState(false);
  const [editingTitle,setEditingTitle]=useState<string|null>(null);
  const [tableEdits,setTableEdits]=useState<Record<string,{card:Card;fields:string[]}>>({});
  const trackTableEdit=(card:Card,field:string,editing:boolean)=>setTableEdits(current=>{const next={...current},entry=next[card.id];if(editing){next[card.id]={card:entry?.card??card,fields:[...new Set([...(entry?.fields??[]),field])]};}else if(entry){const fields=entry.fields.filter(value=>value!==field);if(fields.length)next[card.id]={...entry,fields};else delete next[card.id];}return next;});
  const [fullscreen,setFullscreen]=useState(false);
  const [dragging,setDragging]=useState<string|null>(null);
  const [dropTarget,setDropTarget]=useState<{status:Status;beforeId?:string}|null>(null);
  const draggingRef=useRef<string|null>(null);
  const [sessionBusy,setSessionBusy]=useState<{action:SessionAction;cardId:string}|null>(null);
  const [sessionRequests,setSessionRequests]=useState<PendingSessionRequest[]>([]);
  const [sessionPhase,setSessionPhase]=useState<SessionPhase>('preparing');
  const sessionAbort=useRef<AbortController|null>(null);
  const [sessionFailures,setSessionFailures]=useState<Record<string,{message:string;name:string}>>({});
  const [syncNotices,setSyncNotices]=useState<Record<string,SyncNotice>>({});
  const [createDraft,setCreateDraft]=useState({projectId:'',title:'',sessionMode:'none',sessionName:''});
  const sessionBusyRef=useRef<{action:SessionAction;cardId:string}|null>(null);
  const sessionRequest=useRef(0);
  const boardRef=useRef<HTMLDivElement>(null);
  const dragClickBlocked=useRef(false);
  const dragFromControl=useRef(false);
  const scrollFrame=useRef<number|null>(null);
  const scrollSpeed=useRef(0);
  const mounted=useRef(true);
  const savingRef=useRef(false);
  const connected=useRef(false);
  const queue=useRef<Promise<unknown>>(Promise.resolve());
  const reliable=useRef(new ReliableMutations(client));
  const sessionCreates=useRef(new ReliableSessionCreates(client));
  const loadedPrefs=useRef(false);
  const createdCard=useRef<Card|null>(null);
  const sessionCardDrafts=useRef(new SessionCardDrafts(client));
  const sessionCardSaving=useRef(false);
  const progressSync=useRef(new ReliableProgressSync(client));
  const syncControllers=useRef(new Map<string,AbortController>());
  const lastMutationState=useRef<State|null>(null);
  useEffect(()=>{setModalClosePrompt(false);},[modal?.kind]);
  useEffect(()=>{setDetailDrafts({});setPlanningDraft(null);setDetailClosePrompt(false);},[selected]);
  const refresh=async(options?:{refreshProjects?:boolean})=>{
    if(restorePending.current)return;
    const generation=snapshotGeneration.current,mutation=mutationGeneration.current,request=++snapshotRequest.current;
    const snapshot=await client.snapshot(options);
    if(!mounted.current||generation!==snapshotGeneration.current||mutation!==mutationGeneration.current||request!==snapshotRequest.current)return;
    if(stateRef.current&&snapshot.state.revision<stateRef.current.revision){
      if(savingRef.current||sessionBusyRef.current)return;
      restorePending.current=true;snapshotGeneration.current++;setRestoredSnapshot(snapshot);return;
    }
    sessionCreates.current.restore(snapshot.sessionRequests??[]);setSessionRequests(snapshot.sessionRequests??[]);
    setState(current=>!current||snapshot.state.revision>=current.revision?snapshot.state:current);setCaps(snapshot.capabilities);setProjectDiscovery(snapshot.projectDiscovery);setLoaded(true);setError('');setFullscreen(client.canFullscreen());
    if(!loadedPrefs.current){
      loadedPrefs.current=true;
      const remembered=snapshot.state.preferences.ui;
      setPrefs(remembered?restoredPreferences(remembered):{...defaultPreferences,projectIds:snapshot.currentProjectId?[snapshot.currentProjectId]:'all'});
    }
    return snapshot.state;
  };
  const adoptRestoredSnapshot=(keepDrafts:boolean)=>{
    if(!restoredSnapshot||savingRef.current)return;
    snapshotGeneration.current++;sessionRequest.current++;sessionAbort.current?.abort();sessionBusyRef.current=null;setSessionBusy(null);
    for(const controller of syncControllers.current.values())controller.abort();syncControllers.current.clear();setSyncNotices({});
    reliable.current=new ReliableMutations(client);progressSync.current=new ReliableProgressSync(client);lastMutationState.current=null;
    sessionCreates.current.restore(restoredSnapshot.sessionRequests??[]);setSessionRequests(restoredSnapshot.sessionRequests??[]);
    stateRef.current=restoredSnapshot.state;setState(restoredSnapshot.state);setCaps(restoredSnapshot.capabilities);setProjectDiscovery(restoredSnapshot.projectDiscovery);
    if(!keepDrafts){setTableEdits({});setDetailDrafts({});setPlanningDraft(null);setModal(null);setEditingTitle(null);setTableDraftGeneration(value=>value+1);}
    setDetailClosePrompt(false);setModalClosePrompt(false);setBaselineGeneration(value=>value+1);setRestoredSnapshot(null);restorePending.current=false;setError('');setOperationError('');setNotice(keepDrafts?'已采用恢复后的数据。草稿保留，确认后可逐项保存。':'已采用恢复后的数据，未保存草稿已放弃。');
  };
  useEffect(()=>{
    mounted.current=true;
    void client.connect().then(()=>{connected.current=true;return refresh();}).catch(e=>{if(mounted.current){setError(String(e.message??e));setLoaded(true);}});
    const interval=setInterval(()=>{if(connected.current&&document.visibilityState==='visible'&&!savingRef.current&&!sessionBusyRef.current)void refresh().catch(e=>{if(mounted.current)setError(String(e.message??e));});},5000);
    const cleanup=()=>{sessionAbort.current?.abort();for(const controller of syncControllers.current.values())controller.abort();syncControllers.current.clear();sessionRequest.current++;scrollSpeed.current=0;if(scrollFrame.current!==null)cancelAnimationFrame(scrollFrame.current);scrollFrame.current=null;};
    window.addEventListener('pagehide',cleanup);
    const teardown=()=>{connected.current=false;sessionRequest.current++;clearInterval(interval);cleanup();};
    window.addEventListener('kanban:teardown',teardown);
    return()=>{mounted.current=false;connected.current=false;sessionRequest.current++;clearInterval(interval);cleanup();window.removeEventListener('pagehide',cleanup);window.removeEventListener('kanban:teardown',teardown);client.close();};
  },[client]);

  const mutate=(mutation:Mutation,onFailure?:(message:string)=>void):Promise<boolean>=>{
    const generation=snapshotGeneration.current;
    const run=async()=>{
      if(restorePending.current||generation!==snapshotGeneration.current){const message='数据恢复待确认，本次修改未提交，草稿已保留。';setError(message);onFailure?.(message);return false;}
      mutationGeneration.current++;savingRef.current=true;setSaving(true);setError('');
      try {
        const reply=await reliable.current.apply(mutation);
        lastMutationState.current=reply.state;
        setState(current=>!current||reply.state.revision>=current.revision?reply.state:current);
        if(mutation.type==='session.bind'&&reply.result.status==='confirmation_required'&&reply.result.confirmation){
          const card=reply.state.cards.find(c=>c.id===reply.result.confirmation!.toCardId);
          const session=reply.state.sessions.find(s=>s.id===mutation.sessionId);
          if(card&&session){setModal({kind:'rebind',card,session:{...session,cardId:reply.result.confirmation.fromCardId}});setError('');return false;}
        }
        if(!reply.result.ok){
          if(mutation.type==='session.bind'){
            const currentSession=reply.state.sessions.find(session=>session.id===mutation.sessionId);
            if(currentSession)setModal(current=>current?.kind==='rebind'&&current.session.id===currentSession.id&&(current.session.cardId!==currentSession.cardId||current.session.pendingCardId!==currentSession.pendingCardId)?{...current,session:currentSession}:current);
          }
          const message=reply.result.errors.join('；')||'这次操作未生效';setError(message);onFailure?.(message);return false;
        }
        setNotice(reply.result.warnings.length?reply.result.warnings.join('；'):'已保存');
        if(mutation.type==='card.create'&&reply.result.cardId){createdCard.current=reply.state.cards.find(c=>c.id===reply.result.cardId)??null;setSelected(reply.result.cardId);}
        return true;
      } catch(e){const message=String((e as Error).message??e);setError(message);onFailure?.(message);return false;}
      finally{savingRef.current=false;setSaving(false);}
    };
    const pending=queue.current.then(run);queue.current=pending.catch(()=>{});return pending;
  };
  const preference=(patch:Partial<Preferences>)=>{
    const next={...prefs,...patch};setPrefs(next);
    void mutate({type:'preferences.update',payload:{key:'ui',value:next}});
  };
  const update=(card:Card,fields:Record<string,unknown>,onFailure?:(message:string)=>void)=>mutate({type:'card.update',cardId:card.id,payload:{fields}},onFailure);
  const discardTextDraft=(field:DetailTextField)=>setDetailDrafts(current=>{const next={...current};delete next[field];return next;});
  const requestDetailClose=()=>{
    const dirty=Object.values(detailDrafts).some(draft=>draft.value!==draft.initial)||!!planningDraft&&JSON.stringify(planningDraft.values)!==JSON.stringify(planningValues(planningDraft.initial));
    if(dirty||savingRef.current){setDetailClosePrompt(true);requestAnimationFrame(()=>document.querySelector<HTMLElement>('.detail-unsaved')?.focus());}
    else setSelected(null);
  };
  const saveDetailText=async(card:Card,field:DetailTextField)=>{
    const draft=detailDrafts[field];if(!draft||savingRef.current)return;
    if(draft.value===draft.initial){discardTextDraft(field);return;}
    const ok=await update(card,{[field]:draft.value},message=>setDetailDrafts(current=>({...current,[field]:{...draft,error:`${message} 草稿已保留。`}})));
    if(ok){discardTextDraft(field);setDetailClosePrompt(false);}
  };
  const savePlanning=async(card:Card)=>{
    if(!planningDraft||savingRef.current)return;
    const {initial,values}=planningDraft;
    const fields:Record<string,unknown>={};
    try{
      const next={priority:values.priority,followUpOwner:values.followUpOwner.trim(),dueDate:values.dueDate||null,followUpAt:followUpValue(values.followUpAt,initial.followUpAt),tags:values.tags.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)};
      for(const field of Object.keys(next) as (keyof typeof next)[])if(JSON.stringify(next[field])!==JSON.stringify(initial[field]))fields[field]=next[field];
    }catch(error){setPlanningDraft(current=>current?{...current,error:String((error as Error).message)}:null);return;}
    if(!Object.keys(fields).length){setPlanningDraft(null);return;}
    const ok=await update(card,fields,message=>setPlanningDraft(current=>current?{...current,error:`${message} 草稿已保留。`}:null));
    if(ok){setPlanningDraft(null);setDetailClosePrompt(false);}
  };
  const statusChange=(card:Card,status:Status)=>{
    if(status===card.status)return;
    if(status==='已完成')setModal({kind:'complete',card});
    else void update(card,{status}).then(ok=>{if(ok&&!selected)requestAnimationFrame(()=>document.querySelector<HTMLElement>(`.kanban-card[data-card-id="${CSS.escape(card.id)}"]`)?.focus());});
  };
  const keyboardReorder=(card:Card,direction:number)=>{
    const siblings=selectCards(state!,{...prefs,sort:'order',direction:'asc'}).filter(c=>c.status===card.status);
    const index=siblings.findIndex(c=>c.id===card.id);const target=index+direction;
    if(target<0||target>=siblings.length)return;
    const neighbor=siblings[target]!;const outer=siblings[target+direction];
    const order=outer?(neighbor.order+outer.order)/2:neighbor.order+direction;
    void mutate({type:'card.reorder',cardId:card.id,payload:{order}}).then(ok=>{if(ok)requestAnimationFrame(()=>document.querySelector<HTMLElement>(`.kanban-card[data-card-id="${CSS.escape(card.id)}"]`)?.focus());});
  };
  const stopScroll=()=>{scrollSpeed.current=0;if(scrollFrame.current!==null)cancelAnimationFrame(scrollFrame.current);scrollFrame.current=null;};
  // Disable native drag scrolling and snap while dragging; elapsed time keeps edge speed stable across displays.
  const edgeScroll=(clientX:number)=>{
    const board=boardRef.current;if(!board)return;
    const rect=board.getBoundingClientRect();scrollSpeed.current=clientX<rect.left+48?-240:clientX>rect.right-48?240:0;
    if(scrollFrame.current===null){let previous=performance.now();const tick=(now:number)=>{if(!scrollSpeed.current){scrollFrame.current=null;return;}const elapsed=Math.min(32,Math.max(0,now-previous));previous=now;board.scrollLeft+=scrollSpeed.current*elapsed/1000;scrollFrame.current=requestAnimationFrame(tick);};scrollFrame.current=requestAnimationFrame(tick);}
  };
  const endDrag=()=>{stopScroll();draggingRef.current=null;setDragging(null);setDropTarget(null);};
  const drop=async(status:Status,before?:Card)=>{
    const id=draggingRef.current;endDrag();const card=state?.cards.find(c=>c.id===id);if(!card||before?.id===id||savingRef.current)return;setOperationError('');
    if(card.status!==status&&status==='已完成'){statusChange(card,status);return;}
    const siblings=state!.cards.filter(c=>c.status===status&&c.id!==card.id&&!c.archived&&!c.deleted).sort((a,b)=>a.order-b.order);
    const found=before?siblings.findIndex(c=>c.id===before.id):-1;
    const index=found>=0?found:siblings.length;
    const previous=siblings[index-1]?.order;const after=siblings[index]?.order;
    const order=previous!==undefined&&after!==undefined?(previous+after)/2:after!==undefined?after-1:(previous??0)+1;
    if(card.status!==status&&!await update(card,{status}))return;
    if(card.order!==order&&!await mutate({type:'card.reorder',cardId:card.id,payload:{order}})){setNotice('');setOperationError(card.status!==status?`已移至${status}，排序未保存。卡片显示实际已保存的位置；请重试拖动排序。`:'排序未保存，卡片保持实际已保存的位置；请重试。');}
  };
  const closeModal=(discard=false)=>{
    const protect=modal&&['project','create','edit','item','evidence','resolve','artifact','sessionCard'].includes(modal.kind);
    if(!discard&&protect&&modalForm.current&&(savingRef.current||formValues(modalForm.current)!==modalInitial.current)){setModalClosePrompt(true);requestAnimationFrame(()=>document.querySelector<HTMLElement>('.form-unsaved')?.focus());return;}
    setModalClosePrompt(false);
    if(sessionBusyRef.current){
      if(sessionBusyRef.current.action==='create'&&modal?.kind==='createSession'){const name=modal.name??`#${modal.card.no} ${modal.card.title}`;setSessionFailures(previous=>({...previous,[modal.card.id]:{message:'已停止等待。请求可能仍在处理，重试将继续原请求。',name}}));}
      sessionAbort.current?.abort();sessionRequest.current++;sessionBusyRef.current=null;setSessionBusy(null);
    }
    setModal(null);
  };
  const currentFolder=projectDiscovery?.status==='unavailable'&&projectDiscovery.currentFolder?.startsWith('/')?projectDiscovery.currentFolder:undefined;
  const openCreate=()=>{
    const currentProject=projectDiscovery?.currentProjectId??state?.projects.find(project=>project.folder===currentFolder)?.id;
    const projectId=prefs.projectIds!=='all'?prefs.projectIds[0]??'':currentProject??(currentFolder||projectDiscovery?.status==='unavailable'?'':state?.projects[0]?.id??'');
    setCreateDraft({projectId,title:'',sessionMode:'none',sessionName:''});setError('');
    setModal(state?.projects.length||currentFolder?{kind:'create'}:{kind:'project'});
  };
  const sessionAction=async(action:SessionAction,card:Card,extra:Record<string,unknown>={})=>{
    if(sessionBusyRef.current)return;
    if(!caps.sessions[action]){setError(caps.sessions.reason??'Codex 会话能力尚未接通。');return;}
    const request=++sessionRequest.current;
    const controller=new AbortController();sessionAbort.current=controller;setSessionPhase('preparing');
    const busy={action,cardId:card.id};sessionBusyRef.current=busy;setSessionBusy(busy);setError('');
    if(action==='list')setModal({kind:'sessions',card,sessions:[],loading:true});
    const name=sessionRequests.find(pending=>pending.cardId===card.id)?.name??(typeof extra.name==='string'?extra.name:`#${card.no} ${card.title}`);
    if(action==='create')setModal({kind:'createSession',card,name});
    try {
      if(action==='create'&&extra.abandonConfirmed===true)await sessionCreates.current.abandon({cardId:card.id,projectId:card.projectId},controller.signal);
      const reply=action==='create'?await sessionCreates.current.create({cardId:card.id,projectId:card.projectId,name},{signal:controller.signal,onPhase:phase=>{if(mounted.current&&request===sessionRequest.current)setSessionPhase(phase);}}):sessionReply(action,await client.sessions({action,cardId:card.id,projectId:card.projectId,...extra},{signal:controller.signal}));
      controller.signal.throwIfAborted();
      if(!mounted.current||request!==sessionRequest.current)return;
      if(reply.state)setState(current=>!current||reply.state!.revision>=current.revision?reply.state!:current);
      if(action==='list')setModal({kind:'sessions',card,sessions:visibleSessions(reply.sessions!,card.projectId)});
      else {
        setModal(null);
        try{await refresh();}catch(syncError){if(mounted.current&&request===sessionRequest.current)setError(`会话操作已确认，卡片同步暂未完成：${String((syncError as Error).message??syncError)}`);}
        if(!mounted.current||request!==sessionRequest.current)return;
        if(action==='create'){setSessionFailures(previous=>{const next={...previous};delete next[card.id];return next;});setNotice('会话已创建');}
        else setNotice('已请求打开对应会话');
      }
    }catch(e){
      if(!mounted.current||request!==sessionRequest.current)return;
      const message=String((e as Error).message??e);
      if(e instanceof KnownToolError&&e.code==='PROJECT_AMBIGUOUS'&&e.projectCandidates?.length){setModal({kind:'projectChoice',card,action,extra,candidates:e.projectCandidates});setError('');return;}
      if(action==='create'){setSessionFailures(previous=>({...previous,[card.id]:{message,name}}));try{await refresh();}catch{/* Preserve the creation failure when a refresh also fails. */}}
      if(action==='list')setModal({kind:'sessions',card,sessions:[],loadError:message});
      setError(action==='create'?`尚未确认创建完成，可重试：${message}`:message);
    }finally{if(request===sessionRequest.current){sessionBusyRef.current=null;sessionAbort.current=null;setSessionBusy(null);}}
  };
  const requestSync=async(card:Card,session:Session,manual=false,bindingState:State|null=state,recoverTurnId?:string)=>{
    const target={projectId:card.projectId,cardId:card.id,sessionId:session.id};const key=syncKey(target);
    if(!mounted.current||syncControllers.current.has(key))return;
    const controller=new AbortController();syncControllers.current.set(key,controller);
    setSyncNotices(previous=>({...previous,[key]:{busy:true,message:'正在请求同步进展…'}}));
    try{
      const reply=await progressSync.current.run(target,{manual,recoverTurnId,generation:bindingState?progressSyncEvidence(bindingState,card.id,session.id).generation:undefined,signal:controller.signal,onStatus:reply=>{
        if(!mounted.current||controller.signal.aborted)return;
        const message=reply.message??({dispatch:'已请求会话更新，等待进展报告。',pending:'请求可能已送达，等待进展报告。',deferred:'等待当前回合结束及换绑生效，不打断会话。',disabled:'这个项目尚未启用自动同步。',complete:'已收到同步报告，正在刷新卡片。',recovery_required:'存在尚未收尾的回合。请先核对会话已停止，再确认恢复同步。'}[reply.status]);
        setSyncNotices(previous=>({...previous,[key]:{busy:true,status:reply.status,message,turnId:reply.turnId}}));
      }});
      if(reply.status==='complete'){const fresh=await refresh();if(fresh)progressSync.current.setCompletedGeneration(target,progressSyncEvidence(fresh,card.id,session.id).generation);if(mounted.current&&!controller.signal.aborted)setSyncNotices(previous=>({...previous,[key]:{busy:false,status:'complete',message:''}}));}
    }catch(e){
      if(!mounted.current||controller.signal.aborted)return;
      const message=String((e as Error).message??e);
      setSyncNotices(previous=>({...previous,[key]:{...previous[key],busy:false,error:true,message:`同步尚未确认：${message}`}}));
      if(e instanceof KnownToolError&&e.code==='PROJECT_AMBIGUOUS'&&e.projectCandidates?.length)setModal({kind:'catalogProjectChoice',projectId:card.projectId,candidates:e.projectCandidates,retry:()=>void requestSync(card,session,true)});
    }finally{
      if(syncControllers.current.get(key)===controller)syncControllers.current.delete(key);
      if(mounted.current)setSyncNotices(previous=>previous[key]?{...previous,[key]:{...previous[key],busy:false}}:previous);
    }
  };
  const bindSession=async(card:Card,session:Session,confirmed=false)=>{
    if(savingRef.current||sessionBusyRef.current)return;
    if(session.cardId&&session.cardId!==card.id&&!confirmed){setModal({kind:'rebind',card,session});return;}
    if(await mutate({type:'session.bind',cardId:card.id,sessionId:session.id,payload:{cardId:card.id,confirmed,expectedCurrentCardId:session.cardId??null,expectedPendingCardId:session.pendingCardId??null}})){sessionCardDrafts.current.complete(session.id);setModal(null);void requestSync(card,session,false,lastMutationState.current);}
  };

  const createCardForSession=async(session:Session,title:string,planning:Pick<Card,'followUpOwner'|'followUpAt'|'dueDate'>)=>{
    if(sessionCardSaving.current||savingRef.current||sessionBusyRef.current)return;
    sessionCardSaving.current=true;savingRef.current=true;setSaving(true);setError('');
    try{
      const reply=await sessionCardDrafts.current.create(session,title,planning);
      setState(current=>!current||reply.state.revision>=current.revision?reply.state:current);
      savingRef.current=false;
      await bindSession(reply.card,session);
    }catch(e){setError(String((e as Error).message??e));}
    finally{sessionCardSaving.current=false;savingRef.current=false;setSaving(false);}
  };

  const renderTagChoices=(select:(tag:string)=>void)=><div className="button-row" aria-label="已有标签">{[...new Set((state?.cards??[]).filter(card=>!card.deleted).flatMap(card=>card.tags))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(tag=><button key={tag} type="button" className="button compact" aria-label={`添加标签 ${tag}`} disabled={saving} onClick={()=>select(tag)}>{tag}</button>)}</div>;
  const renderModal=()=>{
    if(!modal||!state)return null;
    const m:Modal=modal.kind!=='edit'&&'card' in modal?{...modal,card:state.cards.find(c=>c.id===modal.card.id)??modal.card}:modal;
    const cardDraft=m.kind==='sessionCard'?sessionCardDrafts.current.get(m.session.id):undefined;
    const pendingCreation='card' in m?sessionRequests.find(request=>request.cardId===m.card.id):undefined;
    const expiredCreation=m.kind==='createSession'&&sessionCreates.current.pendingRequest(m.card.id,m.card.projectId)?.expired===true;
    const draftProject=state.projects.find(project=>project.id===createDraft.projectId);
    const draftSessionName=sessionNamePreview(draftProject?.nextNo??1,createDraft.title,createDraft.sessionName);
    const submit=async(e:FormEvent<HTMLFormElement>)=>{
      e.preventDefault();if(savingRef.current||sessionBusyRef.current)return;const data=new FormData(e.currentTarget);let ok=false;
      let planning:Pick<Card,'followUpOwner'|'followUpAt'|'dueDate'>|undefined;
      if(m.kind==='create'||m.kind==='edit'||m.kind==='sessionCard'){try{planning={followUpOwner:value(data,'followUpOwner'),followUpAt:followUpValue(value(data,'followUpAt'),m.kind==='edit'?m.card.followUpAt:undefined),dueDate:value(data,'dueDate')||null};}catch(e){setError(String((e as Error).message));return;}}
      if(m.kind==='sessionCard'){await createCardForSession(m.session,value(data,'title'),planning!);return;}
      if(m.kind==='project')ok=await mutate({type:'project.upsert',payload:{id:crypto.randomUUID(),name:value(data,'name'),folder:value(data,'folder')}});
      else if(m.kind==='create'){
        createdCard.current=null;
        ok=await mutate({type:'card.create',...(value(data,'projectId')?{projectId:value(data,'projectId')}:{}),payload:{title:value(data,'title'),description:value(data,'description'),priority:value(data,'priority'),...planning,tags:value(data,'tags').split(/[,，]/).map(x=>x.trim()).filter(Boolean),acceptance:value(data,'acceptance').split('\n').filter(Boolean)}});
        const created=createdCard.current as Card|null;
        if(ok&&created&&value(data,'sessionMode')==='create'){setModal(null);await sessionAction('create',created,{name:value(data,'sessionName')||`#${created.no} ${created.title}`});return;}
        if(ok&&created&&value(data,'sessionMode')==='bind'){setModal(null);await sessionAction('list',created);return;}
      }
      else if(m.kind==='edit'){
        const fields:Record<string,unknown>={};
        for(const field of ['title','description','progressText','nextStep'] as const){const raw=String(data.get(field)??'');if(raw!==m.card[field])fields[field]=field==='title'?raw.trim():raw;}
        const displayed={priority:m.card.priority,followUpOwner:m.card.followUpOwner??'',dueDate:m.card.dueDate??'',followUpAt:followUpInput(m.card.followUpAt),tags:m.card.tags.join('，')};
        const submitted={priority:value(data,'priority'),...planning!,tags:value(data,'tags').split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)};
        for(const field of Object.keys(displayed) as (keyof typeof displayed)[])if(String(data.get(field)??'')!==displayed[field])fields[field]=submitted[field];
        for(const field of Object.keys(fields) as (keyof Card)[])if(JSON.stringify(fields[field])===JSON.stringify(m.card[field]))delete fields[field];
        ok=Object.keys(fields).length?await update(m.card,fields):true;
      }
      else if(m.kind==='complete')ok=await mutate({type:'card.complete',cardId:m.card.id,payload:{confirmed:true}});
      else if(m.kind==='item')ok=await mutate({type:m.item?'checklist.update':'checklist.add',cardId:m.card.id,payload:{list:m.list,itemId:m.item?.id,content:value(data,'content'),...(m.list==='blockers'?{blocking:data.get('blocking')==='on',waitingFor:value(data,'waitingFor')}: {})}});
      else if(m.kind==='evidence')ok=await mutate({type:'acceptance.evidence',cardId:m.card.id,payload:{itemId:m.item.id,evidence:{kind:value(data,'kind'),reference:value(data,'reference'),detail:value(data,'detail')}}});
      else if(m.kind==='resolve')ok=await mutate({type:'blocker.resolve',cardId:m.card.id,payload:{itemId:m.item.id,basis:value(data,'basis')}});
      else if(m.kind==='artifact')ok=await mutate({type:'artifact.add',cardId:m.card.id,payload:{title:value(data,'title'),link:value(data,'link')}});
      else if(m.kind==='delete'){ok=await mutate({type:'card.delete',cardId:m.card.id,payload:{}});if(ok)setSelected(null);}
      else if(m.kind==='createSession'){await sessionAction('create',m.card,{name:pendingCreation?.name??value(data,'name')});return;}
      else if(m.kind==='rebind'){await bindSession(m.card,m.session,true);return;}
      if(ok)setModal(null);
    };
    const title=m.kind==='project'?'登记项目':m.kind==='create'?'新建卡片':m.kind==='edit'?'编辑卡片':m.kind==='complete'?'确认完成':m.kind==='item'?`${m.item?'编辑':'新增'}${m.list==='acceptance'?'验收项':m.list==='blockers'?'卡点':'检查项'}`:m.kind==='evidence'?'添加验收依据':m.kind==='resolve'?'解除卡点':m.kind==='artifact'?'添加成果':m.kind==='sessions'?'绑定已有会话':m.kind==='rebind'?'确认换绑':m.kind==='createSession'?'新建 Codex 会话':m.kind==='projectChoice'||m.kind==='catalogProjectChoice'?'选择所属项目':m.kind==='selectCard'?'关联已有卡片':m.kind==='sessionCard'?'新建卡片并关联':'删除已归档卡片';
    return <ModalPanel key={`${m.kind}-${'card' in m?m.card.id:''}`} title={title} returnStatus={m.kind==='complete'?'已完成':'card' in m?m.card.status:undefined} inactive={!!restoredSnapshot} onClose={()=>closeModal()}><form ref={form=>{modalForm.current=form;if(form&&form!==lastModalForm.current){lastModalForm.current=form;modalInitial.current=formValues(form);}}} onSubmit={submit}>
      {modalClosePrompt&&<div className="form-unsaved detail-unsaved" role="alert" tabIndex={-1}><strong>{saving?'正在保存，请稍候。':'有尚未保存的修改'}</strong><p>继续编辑会保留草稿；放弃修改只关闭当前弹窗。</p><div className="detail-edit-actions"><button type="button" className="button primary" onClick={()=>setModalClosePrompt(false)}>继续编辑</button><button type="button" className="button" disabled={saving} onClick={()=>closeModal(true)}>放弃修改</button></div></div>}
      {m.kind==='project'&&<><p className="help">{projectDiscovery?.status==='unavailable'&&!currentFolder?'尚无法确认当前目录。请先选择已登记项目，或核验并填写准确项目文件夹；不会按名称或父目录猜测。':'登记本机项目文件夹，随后可以在项目中建卡。'}</p><Field label="项目名称"><input name="name" required autoFocus placeholder="例如：账号体系"/></Field><Field label="项目文件夹"><input name="folder" required placeholder="/Users/…/project" pattern="/.*"/></Field></>}
      {(m.kind==='create'||m.kind==='edit')&&<>
        {m.kind==='create'&&<><Field label="所属项目"><select name="projectId" value={draftProject?.id??''} onChange={e=>setCreateDraft(previous=>({...previous,projectId:e.target.value}))} required={!currentFolder}>{currentFolder?<option value="">当前文件夹（创建时登记）</option>:<option value="" disabled>请选择已核验的项目</option>}{state.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>{currentFolder&&!draftProject&&<p className="help">创建后保存在此目录对应的项目：{currentFolder}</p>}{!currentFolder&&!draftProject&&<p className="help">尚无法确认当前项目，请先选择并核对所属项目。</p>}</>}
        <Field label="标题"><input name="title" required maxLength={300} autoFocus {...(m.kind==='create'?{value:createDraft.title,onChange:(e:React.ChangeEvent<HTMLInputElement>)=>setCreateDraft(previous=>({...previous,title:e.target.value}))}:{defaultValue:m.card.title})} placeholder="一件需要单独推进的事"/></Field>
        <Field label="描述"><textarea name="description" rows={8} defaultValue={m.kind==='edit'?m.card.description:DESCRIPTION}/></Field>
        <div className="field-grid"><Field label="优先级"><select name="priority" defaultValue={m.kind==='edit'?m.card.priority:'中'}>{['高','中','低'].map(x=><option key={x}>{x}</option>)}</select></Field><Field label="计划交付日"><input name="dueDate" type="date" defaultValue={m.kind==='edit'?m.card.dueDate??'':''}/></Field></div>
        <FollowUpFields card={m.kind==='edit'?m.card:undefined}/><Field label="标签（逗号分隔）"><input name="tags" list="shared-card-tags" defaultValue={m.kind==='edit'?m.card.tags.join('，'):''} placeholder="账号，合规"/></Field>{renderTagChoices(tag=>{const input=modalForm.current?.elements.namedItem('tags');if(input instanceof HTMLInputElement){input.value=[...new Set([...input.value.split(/[，,]/).map(value=>value.trim()).filter(Boolean),tag])].join('，');input.dispatchEvent(new Event('input',{bubbles:true}));}})}
        {m.kind==='create'?<><Field label="验收清单（每行一项）"><textarea name="acceptance" rows={3} placeholder="什么结果算完成？"/></Field><Field label="关联会话"><select name="sessionMode" value={createDraft.sessionMode} onChange={e=>setCreateDraft(previous=>({...previous,sessionMode:e.target.value}))}><option value="none">暂不关联</option><option value="create" disabled={!caps.sessions.create||!!sessionBusy}>新建会话{!caps.sessions.create?'（接入未验证）':''}</option><option value="bind" disabled={!caps.sessions.list||!!sessionBusy}>绑定已有会话{!caps.sessions.list?'（接入未验证）':''}</option></select></Field>{createDraft.sessionMode==='create'&&<><Field label="新会话名称（可选）"><input name="sessionName" value={createDraft.sessionName} onChange={e=>setCreateDraft(previous=>({...previous,sessionName:e.target.value}))} placeholder={sessionNamePreview(draftProject?.nextNo??1,createDraft.title,'')}/></Field><p className="help">名称预览：<output aria-label="会话名称预览">{draftSessionName}</output></p></>}<div className="help">关联后先同步已有进展，再等待新的工作指令。{!caps.sessions.create&&(caps.sessions.reason??'Codex 会话接入尚未验证。')}</div></>:<><Field label="进展"><textarea name="progressText" rows={2} defaultValue={m.card.progressText}/></Field><Field label="下一步"><textarea name="nextStep" rows={3} defaultValue={m.card.nextStep}/></Field></>}
      </>}
      {m.kind==='complete'&&<><p className="dialog-intro">#{m.card.no} {m.card.title}</p><p className="help">完成由你确认。以下内容仍会保留，不会自动勾选验收项。</p><div className="risk-summary">{!m.card.acceptance.length?'尚未设置验收清单。请核对任务结果及下列未完成事项。':Object.values(completionRisks(m.card)).every(n=>n===0)?'所有验收项已通过，暂无待处理风险。':'请确认这些未完成事项可以保留。'}</div>
        <RiskList title="未验收项" items={m.card.acceptance.filter(x=>!x.checked).map(x=>x.content)}/><RiskList title="未解除卡点" items={m.card.blockers.filter(x=>!x.checked).map(x=>`${x.content} · 等${x.waitingFor??'我'}`)}/><RiskList title="未解决冲突" items={m.card.conflicts.filter(x=>!x.resolved).map(x=>`${x.field}：${String(x.current)} / ${String(x.proposed)}`)}/>
      </>}
      {m.kind==='item'&&<><Field label="内容"><textarea name="content" required rows={3} autoFocus defaultValue={m.item?.content}/></Field>{m.list==='blockers'&&<><label className="check-line"><input type="checkbox" name="blocking" defaultChecked={m.item?.blocking??true}/>阻断当前工作</label><Field label="在等谁"><select name="waitingFor" defaultValue={m.item?.waitingFor??'我'}><option>我</option><option>外部</option></select></Field></>}</>}
      {m.kind==='evidence'&&<><p className="dialog-intro">{m.item.content}</p><Field label="证据类型"><select name="kind"><option value="document">文档 / 文件</option><option value="command">命令 / 测试</option><option value="conversation">对话回合</option></select></Field><Field label="文件路径、命令或回合链接"><input name="reference" required autoFocus/></Field><Field label="具体章节、结果或交付摘要"><textarea name="detail" required rows={4}/></Field></>}
      {m.kind==='resolve'&&<><p className="dialog-intro">{m.item.content}</p><Field label="解除依据"><textarea name="basis" required autoFocus rows={4} placeholder="说明获得了什么资料，或确认了什么结果"/></Field></>}
      {m.kind==='artifact'&&<><Field label="成果标题"><input name="title" required autoFocus/></Field><Field label="文件路径、网址或对话回合链接"><input name="link" required/></Field></>}
      {m.kind==='sessions'&&<div className="session-choices">{m.loading?<p className="help" role="status">正在读取这个项目的会话…</p>:m.loadError?<><p className="inline-error">{m.loadError}</p><button type="button" className="button" onClick={()=>void sessionAction('list',m.card)}>重试读取会话</button></>:<>{visibleSessions(m.sessions,m.card.projectId).map(s=><button key={s.id} type="button" className="session-choice" disabled={saving} onClick={()=>void bindSession(m.card,s)}><strong>{s.name}</strong><small>{timeLabel(s.lastActivityAt)} · {s.status}</small><span>{s.cardId?`已绑定 #${state.cards.find(c=>c.id===s.cardId)?.no??'?'}`:'未绑定'}</span></button>)}{!visibleSessions(m.sessions,m.card.projectId).length&&<p className="help">这个项目下暂无可绑定的会话。</p>}</>}</div>}
      {(m.kind==='projectChoice'||m.kind==='catalogProjectChoice')&&<><p className="dialog-intro">这个目录关联了多个 Codex 项目，请选择所属项目。</p><div className="session-choices">{m.candidates.map(candidate=><button key={candidate.id} type="button" className="session-choice" disabled={saving} onClick={()=>{if(savingRef.current)return;const project=state.projects.find(p=>p.id===(m.kind==='projectChoice'?m.card.projectId:m.projectId));if(!project)return;void mutate({type:'project.upsert',payload:{id:project.id,name:project.name,folder:project.folder,hostProjectId:candidate.id}}).then(ok=>{if(ok){setModal(null);if(m.kind==='catalogProjectChoice')m.retry();else void sessionAction(m.action,m.card,m.extra);}});}}><strong>{candidate.name}</strong></button>)}</div><p className="help">只列出与当前文件夹匹配的项目。确认后继续刚才的会话操作。</p></>}
      {m.kind==='rebind'&&<><p className="dialog-intro">{m.session.name}</p><div className="rebind"><span>原卡片</span><strong>{state.cards.some(c=>c.id===m.session.cardId)?`#${state.cards.find(c=>c.id===m.session.cardId)!.no} ${state.cards.find(c=>c.id===m.session.cardId)!.title}`:'原绑定卡片'}</strong>{m.session.pendingCardId&&<><span>待生效卡片</span><strong>{state.cards.some(c=>c.id===m.session.pendingCardId)?`#${state.cards.find(c=>c.id===m.session.pendingCardId)!.no} ${state.cards.find(c=>c.id===m.session.pendingCardId)!.title}`:'待生效的原目标'}</strong></>}<span>目标卡片</span><strong>#{m.card.no} {m.card.title}</strong></div><p className="help">{m.session.status==='运行中'?'会话正在运行，换绑会在本轮结束后生效。本轮报告仍归原卡片。':'确认后，今后的报告写入目标卡片。'} 原卡片的进展和成果保留。</p></>}
      {m.kind==='createSession'&&<>{expiredCreation&&!sessionBusy&&<div className="session-failure"><p>请求过期，可能已有会话。请先核对现有会话。</p><div className="button-row"><button type="button" className="button" disabled={!caps.sessions.list} onClick={()=>void sessionAction('list',m.card)}>核对现有会话</button><button type="button" className="button" disabled={!caps.sessions.create||saving} onClick={()=>void sessionAction('create',m.card,{name:pendingCreation?.name??m.name??`#${m.card.no} ${m.card.title}`,abandonConfirmed:true})}>我已确认没有新会话，重新申请</button></div></div>}{pendingCreation&&!sessionBusy&&!expiredCreation&&<p className="help">这个卡片已有创建请求，可能仍在处理。继续处理原请求，已送达的请求不会重复发送。</p>}<Field label="会话名称"><input name="name" required autoFocus defaultValue={pendingCreation?.name??m.name??`#${m.card.no} ${m.card.title}`} disabled={sessionBusy?.action==='create'||!!pendingCreation}/></Field><p className="help">关联后先同步已有进展，再等待新的工作指令。</p>{sessionBusy?.action==='create'&&<p className="help" role="status">{sessionPhase==='preparing'?'正在准备会话请求…':sessionPhase==='sending'?'正在将请求发送给 Codex…':sessionPhase==='checking'?'请求可能已提交，正在查询创建结果。最多等待 5 分钟。':'已发送请求，等待 Codex 创建并确认会话。最多等待 5 分钟。'}</p>}</>}
      {m.kind==='selectCard'&&<><p className="dialog-intro">{m.session.name}</p><p className="help">选择同项目的卡片；已有绑定时会先确认换绑。</p><div className="session-choices">{sessionCardChoices(state.cards,m.session.projectId).map(card=><button type="button" className="session-choice" key={card.id} disabled={saving} onClick={()=>void bindSession(card,m.session)}><strong>#{card.no} {card.title}</strong><small>{card.status}{card.archived?' · 已归档':''}{m.session.cardId===card.id?' · 当前关联':''}</small></button>)}{!sessionCardChoices(state.cards,m.session.projectId).length&&<p className="help">这个项目还没有可关联的卡片。</p>}</div></>}
      {m.kind==='sessionCard'&&<><p className="help">为「{m.session.name}」手动创建一张卡片，随后关联这条已有会话。</p><Field label="卡片标题"><input name="title" required autoFocus maxLength={300} defaultValue={String(cardDraft?.event.payload.title??m.session.name)} disabled={saving||!!cardDraft}/></Field><FollowUpFields card={cardDraft?.event.payload as Partial<Card>|undefined} disabled={saving||!!cardDraft}/><Field label="计划交付日"><input name="dueDate" type="date" defaultValue={String(cardDraft?.event.payload.dueDate??'')} disabled={saving||!!cardDraft}/></Field>{cardDraft?.card?<p className="help">已创建 #{cardDraft.card.no} {cardDraft.card.title}。重试只继续关联，不会再次建卡。</p>:cardDraft?<p className="help">建卡结果尚未确认，重试会核对原请求，不会另建卡片。</p>:m.session.cardId?<p className="help">这条会话已关联其他卡片。创建后会显示换绑确认；取消换绑时新卡片会保留。</p>:null}</>}
      {m.kind==='delete'&&<p>删除「{m.card.title}」？历史活动仍保留在记录中。</p>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
      <footer className="dialog-footer"><button type="button" className="button" onClick={()=>closeModal()}>{sessionBusy?.action==='create'?'停止等待':'取消'}</button>{m.kind!=='sessions'&&m.kind!=='projectChoice'&&m.kind!=='catalogProjectChoice'&&m.kind!=='selectCard'&&<button className={`button ${m.kind==='delete'?'danger':'primary'}`} type="submit" disabled={saving||!!sessionBusy}>{sessionBusy?.action==='create'?'新建中…':saving?'保存中…':m.kind==='complete'?'确认完成':m.kind==='delete'?'确认删除':m.kind==='rebind'?'确认换绑':m.kind==='sessionCard'?(cardDraft?.card?'继续关联':'创建并关联'):m.kind==='createSession'&&expiredCreation?'查询原请求':m.kind==='createSession'&&pendingCreation?(sessionCreates.current.needsDispatch(m.card.id,m.card.projectId)?'重试发送':'继续等待'):'保存'}</button>}</footer>
    </form></ModalPanel>;
  };

  const renderChecklist=(card:Card,list:'checklist'|'acceptance'|'blockers',title:string)=>{
    const items=card[list];
    return <section className="detail-section" aria-label={title}><div className="section-heading"><h2>{title}<small>{list==='acceptance'?(card.progress?.label??'尚无验收项'):`${items.filter(i=>i.checked).length}/${items.length}`}</small></h2><button className="text-button" onClick={()=>setModal({kind:'item',card,list})}>＋ 添加</button></div>
      {!items.length&&<p className="help">{list==='acceptance'?'写下可核对的完成条件。':list==='blockers'?'目前没有卡点。':'把工作拆成可执行的小步骤。'}</p>}
      <div className="checklist">{items.map(item=><div key={item.id} className={`checklist-item ${item.checked?'checked':''}`}>
        <label className="check-line"><input type="checkbox" checked={item.checked} aria-label={`${list==='acceptance'?'验收':list==='blockers'?'解除':'完成'}：${item.content}`} onChange={()=>{if(list==='blockers'&&!item.checked)setModal({kind:'resolve',card,item});else void mutate({type:'checklist.check',cardId:card.id,payload:{list,itemId:item.id,checked:!item.checked}});}}/><span>{item.content}</span></label>
        <div className="item-meta">{(item.source.kind==='session'||item.source.kind==='assistant')&&<span className="badge">AI 添加</span>}{list==='acceptance'&&<span className={`badge ${item.checked?'good':item.acceptanceState==='待确认'?'warm':''}`}>{item.acceptanceState}</span>}{list==='blockers'&&<><span className={item.blocking?'badge red':'badge'}>{item.blocking?'阻断':'提醒'}</span><span>等{item.waitingFor??'我'}</span>{item.resolution&&<span>解除依据：{item.resolution}</span>}</>}</div>
        {item.evidence.length>0&&<div className={`evidence-list ${item.rejected?'rejected':''}`}>{item.evidence.map((e,i)=><div key={i}><strong>{e.kind==='command'?'测试':e.kind==='document'?'文件':'对话'}</strong><code>{e.reference}</code><p>{e.detail}</p></div>)}</div>}
        <div className="item-actions">{list==='acceptance'&&<><button className="text-button" onClick={()=>setModal({kind:'evidence',card,item})}>附证据</button>{item.evidence.length>0&&!item.checked&&<button className="text-button" onClick={()=>void mutate({type:'acceptance.reject',cardId:card.id,payload:{itemId:item.id}})}>不认可</button>}</>}<button className="text-button" onClick={()=>setModal({kind:'item',card,list,item})}>编辑</button><button className="text-button muted" onClick={()=>void mutate({type:'checklist.delete',cardId:card.id,payload:{list,itemId:item.id}})}>删除</button></div>
      </div>)}</div>
    </section>;
  };
  const renderActivity=(activity:Activity)=>{
    const presentation=presentActivity(activity);
    const body=<><p>{presentation.title}</p>{activity.quote&&<blockquote>{activity.quote}</blockquote>}{activity.reason&&<p className="help">原因：{activity.reason}</p>}{presentation.changes.map((line,i)=><p className="activity-change" key={i}>{line}</p>)}{activity.warnings.map((w,i)=><p className="help" key={i}>{w}</p>)}{activity.errors.map((e,i)=><p className="inline-error" key={i}>{e}</p>)}{activity.changes.length>0&&<button className="text-button" onClick={()=>void mutate({type:'activity.undo',cardId:activity.cardId,payload:{activityId:activity.id}})}>撤销这次修改</button>}</>;
    return <article className="activity" key={activity.id}><div className="activity-head"><span>{activity.actor.kind==='assistant'?`${SOURCE_LABELS.assistant}${activity.actor.name?` · ${activity.actor.name}`:''}`:activity.actor.name??SOURCE_LABELS[activity.actor.kind]}</span><time>{timeLabel(activity.at)}</time><span>{activity.result}</span></div>{activity.collapsed?<details><summary>无变化报告</summary>{body}</details>:body}</article>;
  };
  const renderSyncStatus=(card:Card,session:Session)=>{
    const target={projectId:card.projectId,cardId:card.id,sessionId:session.id};const notice=syncNotices[syncKey(target)];
    const evidence=progressSyncEvidence(state!,card.id,session.id);const configured=caps.automaticSync?.configuredProjectIds.includes(card.projectId)===true;
    const label=notice?.status==='disabled'&&evidence.label!=='已同步'?'待补同步':evidence.label;
    const message=notice?.message||(!configured?(caps.automaticSync?.message??'这个项目的自动同步配置尚未确认。'):session.pendingCardId===card.id?'等待本轮结束后关联并同步。':'');
    return <div className="progress-sync" data-sync-session={session.id}><small className="progress-sync-label">{label}{evidence.at?` · ${timeLabel(evidence.at)}`:''}</small>{message&&<small className={notice?.error?'inline-error':'help'}>{message}</small>}{notice?.status==='recovery_required'&&notice.turnId&&<button type="button" className="button compact" disabled={notice.busy} onClick={()=>void requestSync(card,session,true,state,notice.turnId)}>确认会话已停止，恢复同步</button>}<button type="button" className="text-button" disabled={notice?.busy} onClick={()=>void requestSync(card,session,true)}>{notice?.busy?'等待同步…':progressSync.current.pending(target)?'查看同步状态':'同步进展'}</button></div>;
  };
  const renderDetailText=(card:Card,field:DetailTextField,label:string)=>{
    const draft=detailDrafts[field];
    const begin=()=>setDetailDrafts(current=>({...current,[field]:{initial:card[field],value:card[field],error:''}}));
    return <section className="detail-section detail-text-section" aria-label={label}>
      <div className="section-heading"><h2>{label}</h2>{!draft&&<button type="button" className="text-button" aria-label={`编辑${label}`} onClick={begin}>编辑</button>}</div>
      {draft?<form className="detail-inline-form" onSubmit={event=>{event.preventDefault();void saveDetailText(card,field);}}>
        <textarea aria-label={label} rows={field==='description'?6:3} autoFocus value={draft.value} disabled={saving} onChange={event=>{const value=event.target.value;setDetailDrafts(current=>({...current,[field]:{...draft,value}}));}}/>
        {draft.error&&<p className="inline-error" role="alert">{draft.error}</p>}
        <div className="detail-edit-actions"><button type="submit" className="button primary" disabled={saving}>{saving?'保存中…':'保存'}</button><button type="button" className="button" disabled={saving} onClick={()=>discardTextDraft(field)}>取消</button></div>
      </form>:card[field]?<p className="detail-text-content">{card[field]}</p>:<button type="button" className="detail-empty-add" onClick={begin}>＋ 添加{label}</button>}
    </section>;
  };
  const renderPlanning=(card:Card)=>{
    const change=(field:keyof PlanningValues,value:string)=>setPlanningDraft(current=>current?{...current,values:{...current.values,[field]:value}}:null);
    return <section className="detail-section detail-arrangement" aria-label="安排"><div className="section-heading"><h2>安排</h2>{!planningDraft&&<button type="button" className="text-button" onClick={()=>setPlanningDraft({initial:{priority:card.priority,followUpOwner:card.followUpOwner,followUpAt:card.followUpAt,dueDate:card.dueDate,tags:[...card.tags]},values:planningValues(card),error:''})}>编辑安排</button>}</div>
      {planningDraft?<form className="detail-inline-form" onSubmit={event=>{event.preventDefault();void savePlanning(card);}}>
        <div className="detail-planning-fields"><Field label="优先级"><select value={planningDraft.values.priority} disabled={saving} onChange={event=>change('priority',event.target.value)}>{['高','中','低'].map(priority=><option key={priority}>{priority}</option>)}</select></Field><Field label="跟进人"><input value={planningDraft.values.followUpOwner} disabled={saving} onChange={event=>change('followUpOwner',event.target.value)} placeholder="待指定"/></Field><Field label="计划交付日"><input type="date" value={planningDraft.values.dueDate} disabled={saving} onChange={event=>change('dueDate',event.target.value)}/></Field><Field label="跟进时间（北京时间）"><input type="datetime-local" step="60" value={planningDraft.values.followUpAt} disabled={saving} onChange={event=>change('followUpAt',event.target.value)}/></Field></div>
        <Field label="标签（逗号分隔）"><input value={planningDraft.values.tags} list="shared-card-tags" disabled={saving} onChange={event=>change('tags',event.target.value)} placeholder="账号，合规"/></Field>{renderTagChoices(tag=>change('tags',[...new Set([...planningDraft.values.tags.split(/[，,]/).map(value=>value.trim()).filter(Boolean),tag])].join('，')))}
        {planningDraft.error&&<p className="inline-error" role="alert">{planningDraft.error}</p>}
        <div className="detail-edit-actions"><button type="submit" className="button primary" disabled={saving}>{saving?'保存中…':'保存'}</button><button type="button" className="button" disabled={saving} onClick={()=>setPlanningDraft(null)}>取消</button></div>
      </form>:<dl className="detail-planning"><div><dt>跟进人</dt><dd>{card.followUpOwner||'待指定'}</dd></div><div className="delivery-date"><dt>计划交付日</dt><dd>{card.dueDate??'未设置'}</dd></div>{card.followUpAt&&<div><dt>跟进时间（北京时间）</dt><dd>{followUpInput(card.followUpAt).replace('T',' ')}</dd></div>}<div className="detail-planning-priority"><dt>优先级</dt><dd>{card.priority}</dd></div>{card.tags.length>0&&<div className="detail-planning-tags"><dt>标签</dt><dd>{card.tags.map(tag=><span className="badge" key={tag}>{tag}</span>)}</dd></div>}</dl>}
    </section>;
  };
  const renderDetail=(card:Card)=>{
    const project=state!.projects.find(p=>p.id===card.projectId);
    const hasDescription=!!card.description.trim();
    const relatedSessions=state!.sessions.filter(session=>session.cardId===card.id||session.pendingCardId===card.id||card.members.some(member=>member.sessionId===session.id));
    const runningCount=relatedSessions.filter(session=>session.status==='运行中').length;
    const pendingBindCount=relatedSessions.filter(session=>session.pendingCardId).length;
    const syncFailureCount=relatedSessions.filter(session=>syncNotices[syncKey({cardId:card.id,sessionId:session.id})]?.error).length;
    const missingCount=relatedSessions.filter(session=>session.status==='找不到').length;
    const pendingCreates=sessionRequests.filter(request=>request.cardId===card.id);
    const waitingReport=card.members.some(member=>progressSyncEvidence(state!,card.id,member.sessionId).label==='等待首次同步');
    const activities=state!.activities.filter(activity=>activity.cardId===card.id).slice().reverse();
    const latestActivity=activities[0];
    return <div className="detail" key={card.id}>
      <div className="detail-nav"><span>{project?.name} · #{card.no}</span></div>
      <div className="detail-title"><div><p className="eyebrow">{card.archived?'已归档卡片':'项目卡片'}</p><h1>{card.title}</h1></div><button className="button" onClick={()=>setModal({kind:'edit',card})}>编辑</button></div>
      <div className="detail-properties"><select aria-label="卡片状态" value={card.status} onChange={e=>statusChange(card,e.target.value as Status)}>{STATUSES.map(s=><option key={s}>{s}</option>)}</select>{card.flags.map(flag=><span key={flag} className="badge red">{flag}</span>)}</div>
      {renderPlanning(card)}
      {renderDetailText(card,'progressText','进展')}{renderDetailText(card,'nextStep','下一步')}{(hasDescription||detailDrafts.description)&&renderDetailText(card,'description','目标与范围')}
      {card.acceptance.length>0&&renderChecklist(card,'acceptance','验收清单')}{card.blockers.length>0&&renderChecklist(card,'blockers','卡点')}{card.checklist.length>0&&renderChecklist(card,'checklist','检查清单')}
      {(!hasDescription&&!detailDrafts.description||!card.acceptance.length||!card.blockers.length||!card.checklist.length||!card.artifacts.length)&&<section className="detail-section detail-add-content" aria-label="添加内容"><h2>添加内容</h2><div className="detail-add-actions">
        {!hasDescription&&!detailDrafts.description&&<button type="button" aria-label="添加目标与范围" onClick={()=>setDetailDrafts(current=>({...current,description:{initial:card.description,value:card.description,error:''}}))}>＋ 目标与范围</button>}
        {!card.acceptance.length&&<button type="button" aria-label="添加验收项" onClick={()=>setModal({kind:'item',card,list:'acceptance'})}>＋ 验收项</button>}
        {!card.blockers.length&&<button type="button" aria-label="添加卡点" onClick={()=>setModal({kind:'item',card,list:'blockers'})}>＋ 卡点</button>}
        {!card.checklist.length&&<button type="button" aria-label="添加检查项" onClick={()=>setModal({kind:'item',card,list:'checklist'})}>＋ 检查项</button>}
        {!card.artifacts.length&&<button type="button" aria-label="添加成果" onClick={()=>setModal({kind:'artifact',card})}>＋ 成果</button>}
      </div></section>}
      <details className="detail-section detail-fold" key={`sessions-${card.id}`}><summary aria-label="关联会话"><span className="detail-fold-title">关联会话</span><span className="detail-fold-count">{card.members.length} 个</span><span className="detail-fold-status">{runningCount>0&&<span>{runningCount} 个运行中</span>}{pendingBindCount>0&&<span>{pendingBindCount} 个待换绑</span>}{syncFailureCount>0&&<span className="detail-summary-error">{syncFailureCount} 个同步失败</span>}{missingCount>0&&<span className="detail-summary-error">{missingCount} 个会话找不到</span>}{card.sessionCreationError&&<span className="detail-summary-error">创建失败</span>}{sessionFailures[card.id]&&<span className="detail-summary-error">创建待确认</span>}{pendingCreates.length>0&&<span>{pendingCreates.some(request=>request.status==='expired')?'创建待核对':`${pendingCreates.length} 个等待创建`}</span>}{!pendingCreates.length&&sessionBusy?.cardId===card.id&&sessionBusy.action==='create'&&<span>等待创建</span>}{!syncFailureCount&&card.needsSync&&<span className="detail-summary-error">待补同步</span>}{!syncFailureCount&&!card.needsSync&&waitingReport&&<span>等待首次同步</span>}</span></summary><div className="detail-fold-body"><div className="button-row"><button className="button" disabled={!caps.sessions.create||!!sessionBusy} onClick={()=>setModal({kind:'createSession',card})}>{sessionRequests.some(request=>request.cardId===card.id)?'继续等待创建结果':'新建会话'}</button><button className="button" disabled={!caps.sessions.list||!!sessionBusy} onClick={()=>void sessionAction('list',card)}>绑定已有会话</button></div>
        {(!caps.sessions.create||!caps.sessions.list)&&<p className="capability-note">{caps.sessions.reason??'Codex 会话接入尚未验证，暂不能新建或绑定会话。'}</p>}
        {(card.sessionCreationError||sessionFailures[card.id])&&<div className="session-failure"><p className="inline-error">{sessionFailures[card.id]?'尚未确认创建完成：':'创建失败：'}{sessionFailures[card.id]?.message??card.sessionCreationError}</p><button className="button" disabled={!caps.sessions.create||!!sessionBusy} onClick={()=>{setError('');setModal({kind:'createSession',card,name:sessionFailures[card.id]?.name});}}>重试创建会话</button></div>}
        {card.members.map(member=><div className="member" key={member.sessionId}><span className={`session-dot ${member.status==='运行中'?'running':''}`}/><div><strong>{member.name}</strong><small>{member.role} · 会话{member.status}{state!.sessions.find(s=>s.id===member.sessionId)?.pendingCardId?' · 本轮结束后换绑':''}</small>{state!.sessions.find(s=>s.id===member.sessionId)&&renderSyncStatus(card,state!.sessions.find(s=>s.id===member.sessionId)!)}</div><button className="text-button" disabled={!caps.sessions.open||!!sessionBusy} onClick={()=>void sessionAction('open',card,{sessionId:member.sessionId})}>打开会话</button><button className="text-button muted" onClick={()=>void mutate({type:'session.unbind',cardId:card.id,sessionId:member.sessionId,payload:{}})}>解绑</button></div>)}
        {state!.sessions.filter(session=>session.pendingCardId===card.id&&session.cardId!==card.id).map(session=><div className="member" key={`pending-${session.id}`}><div><strong>{session.name}</strong><small>会话{session.status} · 等待换绑生效</small>{renderSyncStatus(card,session)}</div></div>)}
      </div></details>
      {card.artifacts.length>0&&<section className="detail-section" aria-label="成果"><div className="section-heading"><h2>成果 <small>{card.artifacts.length}</small></h2><button className="text-button" onClick={()=>setModal({kind:'artifact',card})}>＋ 添加</button></div>{card.artifacts.map(a=><article className="artifact" key={a.id}><div><strong>{a.title}</strong>{safeExternalLink(a.link)?<a href={safeExternalLink(a.link)!} target="_blank" rel="noreferrer">{a.link} ↗</a>:<code>{a.link}</code>}<small>{timeLabel(a.at)} · {a.source.name??SOURCE_LABELS[a.source.kind]}</small></div><button className="text-button muted" onClick={()=>void mutate({type:'artifact.delete',cardId:card.id,payload:{artifactId:a.id}})}>移除</button></article>)}</section>}
      {card.conflicts.some(c=>!c.resolved)&&<section className="detail-section"><h2>待处理冲突</h2>{card.conflicts.filter(c=>!c.resolved).map(c=><div className="conflict" key={c.id}><strong>{c.field}</strong><p>当前：{shortValue(c.current)}</p><p>会话建议：{shortValue(c.proposed)}</p><p className="help">编辑对应字段后，这条冲突会自动关闭。</p></div>)}</section>}
      <details className="detail-section detail-fold" key={`activity-${card.id}`}><summary aria-label="活动"><span className="detail-fold-title">活动</span><span className="detail-fold-count">{activities.length} 条</span>{latestActivity&&<span className="detail-fold-preview">{latestActivity.errors.length>0&&<span className="detail-summary-error">最近操作未生效 · </span>}{presentActivity(latestActivity).title}</span>}</summary><div className="detail-fold-body"><form className="comment-form" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const content=value(new FormData(form),'content');if(content)void mutate({type:'comment.add',cardId:card.id,payload:{content}}).then(ok=>{if(ok)form.reset();});}}><textarea name="content" aria-label="添加备注" placeholder="添加一条备注…" rows={2} required/><button className="button" type="submit">记录</button></form>{activities.map(renderActivity)}</div></details>
      <footer className="detail-footer"><button className="button" onClick={()=>void mutate({type:'card.archive',cardId:card.id,payload:{archived:!card.archived}})}>{card.archived?'恢复卡片':'归档卡片'}</button>{card.archived&&<button className="button danger" onClick={()=>setModal({kind:'delete',card})}>删除</button>}{card.status!=='已完成'&&!card.archived&&<button className="button primary" onClick={()=>setModal({kind:'complete',card})}>确认完成</button>}</footer>
    </div>;
  };
  const renderCard=(card:Card,multiple:boolean)=>{
    const main=card.members.find(m=>m.role==='主会话');
    const openUnavailable=main?.status==='已归档'?'会话已归档，请在 Codex 恢复后打开':main?.status==='找不到'?'找不到绑定的主会话，请在详情中核对关联':!caps.sessions.open?(caps.sessions.reason??'会话打开暂不可用'):undefined;
    const controls='button,input,select,textarea,a,summary,details,[contenteditable="true"]';
    const overdue=!!card.dueDate&&card.dueDate<businessDate(new Date())&&card.status!=='已完成';
    return <article key={card.id} data-card-id={card.id} data-drop-before={dropTarget?.beforeId===card.id?'true':undefined} className={`kanban-card ${dragging===card.id?'dragging':''}`} draggable tabIndex={0} aria-label={`卡片 #${card.no} ${card.title}，${card.status}`} onPointerDown={e=>{dragClickBlocked.current=false;dragFromControl.current=!!(e.target as Element).closest(controls)&&!(e.target as Element).closest('.card-title');}} onClick={e=>{if(!dragClickBlocked.current&&!(e.target as Element).closest(controls))setSelected(card.id);}} onDragStart={e=>{if(dragFromControl.current||savingRef.current){e.preventDefault();return;}dragClickBlocked.current=true;draggingRef.current=card.id;setDragging(card.id);setDropTarget(null);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',card.id);}} onDragEnd={endDrag} onDragOver={e=>{if(!draggingRef.current)return;e.preventDefault();e.dataTransfer.dropEffect='move';setDropTarget({status:card.status,beforeId:card.id===draggingRef.current?undefined:card.id});}} onDrop={e=>{e.preventDefault();e.stopPropagation();void drop(card.status,card);}} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.altKey&&(e.key==='ArrowRight'||e.key==='ArrowLeft')){e.preventDefault();statusChange(card,nextStatus(card.status,e.key==='ArrowRight'?1:-1));}else if(e.altKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();keyboardReorder(card,e.key==='ArrowUp'?-1:1);}else if(e.key==='Enter'){e.preventDefault();setSelected(card.id);}}}>
      <div className="card-topline"><span>{multiple?`${state!.projects.find(p=>p.id===card.projectId)?.name??''} · `:''}#{card.no}</span><span className={`priority-dot priority-${card.priority}`} aria-label={`${card.priority}优先级`}/></div>
      <button className="card-title" onClick={e=>{if(!dragClickBlocked.current||e.detail===0)setSelected(card.id);}}>{card.title}</button>
      <p className="card-progress-text"><span>进展</span>{card.progressText||'等待同步'}</p>
      <p className="card-next"><span>下一步</span>{card.nextStep||'待补充'}</p>
      <div className="card-planning-row"><div className="card-owner"><span>跟进人</span><strong title={card.followUpOwner||'待指定'}>{card.followUpOwner||'待指定'}</strong></div><div className={`card-delivery ${overdue?'overdue':''}`} title={overdue?'计划交付日 · 已逾期':'计划交付日'}><span>计划交付日</span><strong>{card.dueDate??'未设置'}</strong></div></div>
      <div className="tags">{card.flags.map(f=><span key={f} className="badge red">{f}</span>)}{card.tags.map(t=><span key={t} className="badge">{t}</span>)}{card.archived&&<span className="badge">已归档</span>}</div>
      <div className="card-footer">{main?<><span><i className={`session-dot ${main.status==='运行中'?'running':''}`}/>会话{main.status}</span><button type="button" className="text-button card-open-session" disabled={!!openUnavailable||!!sessionBusy} title={openUnavailable??`打开主会话：${main.name}`} onClick={e=>{e.stopPropagation();void sessionAction('open',card,{sessionId:main.sessionId});}}>{sessionBusy?.action==='open'&&sessionBusy.cardId===card.id?'正在打开…':<>打开会话 <span aria-hidden="true">↗</span></>}</button></>:<span>{card.members.length?'未关联主会话':'未关联会话'}</span>}</div>
      <details className="card-menu"><summary aria-label={`卡片 #${card.no} 操作`}>•••</summary><div><button onClick={()=>setSelected(card.id)}>查看详情</button><button onClick={()=>setModal({kind:'edit',card})}>编辑</button><button disabled={!caps.sessions.create||!!sessionBusy} onClick={()=>setModal({kind:'createSession',card})}>{sessionRequests.some(request=>request.cardId===card.id)?'继续等待创建结果':'新建会话'}</button><button disabled={!caps.sessions.list||!!sessionBusy} onClick={()=>void sessionAction('list',card)}>绑定已有会话</button><button onClick={()=>void mutate({type:'card.archive',cardId:card.id,payload:{archived:!card.archived}})}>{card.archived?'恢复卡片':'归档卡片'}</button></div></details>
    </article>;
  };

  if(!loaded)return <div className="loading"><KanbanLogo/><p>正在连接项目管理…</p><small>连接本机数据</small></div>;
  if(!state)return <div className="connection-error"><h1>项目管理暂未连接</h1><p>{error||'未收到插件数据。'}</p><p className="help">请从 Codex App 中的项目管理插件入口打开。连接失败不会创建或修改卡片。</p><button className="button" onClick={()=>{setLoaded(false);void client.connect().then(()=>refresh()).catch(e=>{setError(String(e.message));setLoaded(true);});}}>重新连接</button></div>;
  const matchingCards=selectCards(state,prefs.format==='board'?{...prefs,sort:'order',direction:'asc'}:prefs);
  const matchingIds=new Set(matchingCards.map(card=>card.id));
  const cards=prefs.format==='table'?[...matchingCards,...Object.keys(tableEdits).filter(id=>!matchingIds.has(id)).flatMap(id=>{const card=state.cards.find(card=>card.id===id&&!card.deleted);return card?[card]:[];})].map(card=>{const edit=tableEdits[card.id];return edit&&prefs.groupBy?{...card,[prefs.groupBy]:edit.card[prefs.groupBy]}:card;}):matchingCards;
  const selectedCard=state.cards.find(c=>c.id===selected&&!c.deleted);
  const visibleIds=new Set(cards.map(c=>c.id));
  const notifications=state.notifications.filter(n=>n.status==='待处理'&&visibleIds.has(n.cardId));
  const notificationGroups=new Map<string,Notification[]>();for(const n of notifications)notificationGroups.set(n.type,[...(notificationGroups.get(n.type)??[]),n]);
  const multiple=prefs.projectIds==='all'?state.projects.length>1:prefs.projectIds.length>1;
  const uiError=operationError||error;
  const activeFilters=[prefs.status,prefs.priority,prefs.tag,prefs.dueBefore,prefs.followUpOwner,prefs.hasBlockers,prefs.includeArchived].filter(Boolean).length;
  const projectLabel=prefs.projectIds==='all'?'全部项目':prefs.projectIds.length===1?(state.projects.find(p=>p.id===prefs.projectIds[0])?.name??'选择项目'):`${prefs.projectIds.length} 个项目`;
  return <main className="app-shell" data-section={area}>
    <datalist id="shared-card-tags">{[...new Set(state.cards.filter(card=>!card.deleted).flatMap(card=>card.tags))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(tag=><option key={tag} value={tag}/>)}</datalist>
    <div className="app-content" inert={!!selectedCard||!!modal||!!restoredSnapshot}>
    {client.preview&&<div className="preview-banner"><b>本地验收</b><span>隔离测试数据 · 非 Codex 宿主验收</span></div>}
    <header className="app-header"><div className="brand"><KanbanLogo/><strong>项目管理</strong><span className="edition">KANBAN</span></div><div className="header-actions">{fullscreen&&<button className="icon-button" aria-label="全屏" onClick={()=>void client.fullscreen().then(ok=>{if(!ok)setNotice('Codex 未切换到全屏，继续使用当前侧栏。');}).catch(e=>setError(String(e.message)))}>⛶</button>}<button className="icon-button" aria-label="刷新" disabled={saving||!!sessionBusy} onMouseDown={event=>event.preventDefault()} onClick={()=>void refresh({refreshProjects:true}).catch(e=>setError(String(e.message)))}>↻</button></div></header>
    <div className="sync-strip"><span className={`sync-dot ${uiError||state.syncError?'failed':saving?'pending':''}`}/><span>{operationError?'操作未完整保存':error||state.syncError?'同步失败，保留上次有效数据':saving?'正在保存…':notice||'已连接本机数据'}</span><time>{timeLabel(state.syncError?.lastUpdatedAt??state.updatedAt)}</time></div>
    {uiError&&<div className="error-banner" role="alert"><span>{uiError}</span><button onClick={()=>{setError('');setOperationError('');}} aria-label="关闭错误提示">×</button></div>}
    <>
      <section className="workspace-controls"><div className="project-row"><div className="project-picker"><button className="project-button" aria-expanded={projectMenu} onClick={()=>setProjectMenu(!projectMenu)}><span>▱</span><strong>{projectLabel}</strong><span>⌄</span></button>{projectMenu&&<div className="project-popover"><label className="check-line"><input type="checkbox" checked={prefs.projectIds==='all'} onChange={()=>preference({projectIds:'all'})}/>全部项目</label>{state.projects.map(p=><label className="check-line" key={p.id}><input type="checkbox" checked={prefs.projectIds!=='all'&&prefs.projectIds.includes(p.id)} onChange={()=>{const ids=prefs.projectIds==='all'?[]:[...prefs.projectIds];preference({projectIds:ids.includes(p.id)?ids.filter(id=>id!==p.id):[...ids,p.id]});}}/>{p.name}</label>)}<button className="text-button" onClick={()=>{setProjectMenu(false);setModal({kind:'project'});}}>＋ 登记项目</button><button className="button compact" onClick={()=>setProjectMenu(false)}>确定</button></div>}</div>{area==='tasks'&&<button className="button primary" onClick={openCreate}>＋ 新建卡片</button>}</div>
        <nav className="scope-tabs" aria-label="内容类型"><button aria-pressed={area==='tasks'} className={area==='tasks'?'active':''} onClick={()=>setArea('tasks')}>任务</button><button aria-pressed={area==='sessions'} className={area==='sessions'?'active':''} onClick={()=>setArea('sessions')}>会话 <span>{state.sessions.filter(session=>prefs.projectIds==='all'||prefs.projectIds.includes(session.projectId)).length}</span></button></nav>
        {area==='tasks'&&<nav className="view-tabs" aria-label="内置视图">{VIEWS.map(view=><button key={view} className={prefs.view===view?'active':''} onClick={()=>preference({view})}>{view}{view==='需要我处理'&&<span>{state.notifications.filter(n=>n.status==='待处理'&&(prefs.projectIds==='all'||prefs.projectIds.includes(n.projectId))).length}</span>}</button>)}</nav>}
      </section>
      {area==='sessions'?<SessionCatalog key={baselineGeneration} renderSync={renderSyncStatus} state={state} projectIds={prefs.projectIds} caps={caps} client={client} onState={next=>setState(current=>!current||next.revision>=current.revision?next:current)} onBind={session=>{setError('');setModal({kind:'selectCard',session});}} onNewCard={session=>{setError('');setModal({kind:'sessionCard',session});}} onCard={card=>setSelected(card.id)} onAmbiguous={(projectId,candidates,retry)=>setModal({kind:'catalogProjectChoice',projectId,candidates,retry})}/>:<>
      <div className="view-toolbar"><div><span className="view-count">{prefs.view==='需要我处理'?`${notifications.length} 件待处理`:`${cards.length} 张卡片`}</span>{prefs.view!=='需要我处理'&&<div className="segmented" aria-label="显示方式"><button className={prefs.format==='board'?'selected':''} aria-pressed={prefs.format==='board'} onClick={()=>preference({format:'board'})}>看板</button><button className={prefs.format==='table'?'selected':''} aria-pressed={prefs.format==='table'} onClick={()=>preference({format:'table'})}>表格</button></div>}</div><button className={`text-button ${activeFilters?'accent':''}`} aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(!filtersOpen)}>筛选{activeFilters?` · ${activeFilters}`:' ＋'}</button></div>
      {filtersOpen&&<div className="filters"><Field label="状态"><select value={prefs.status} onChange={e=>preference({status:e.target.value as Preferences['status']})}><option value="">不限状态</option>{STATUSES.map(s=><option key={s}>{s}</option>)}</select></Field><Field label="优先级"><select value={prefs.priority} onChange={e=>preference({priority:e.target.value as Preferences['priority']})}><option value="">不限优先级</option>{['高','中','低'].map(s=><option key={s}>{s}</option>)}</select></Field><Field label="标签"><select value={prefs.tag} onChange={e=>preference({tag:e.target.value})}><option value="">全部标签</option>{[...new Set(state.cards.flatMap(c=>c.tags))].map(t=><option key={t}>{t}</option>)}</select></Field><Field label="跟进人"><select value={prefs.followUpOwner} onChange={e=>preference({followUpOwner:e.target.value})}><option value="">不限跟进人</option>{[...new Set(state.cards.map(c=>c.followUpOwner).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(name=><option key={name}>{name}</option>)}</select></Field><Field label="计划交付日不晚于"><input type="date" value={prefs.dueBefore} onChange={e=>preference({dueBefore:e.target.value})}/></Field><label className="check-line"><input type="checkbox" checked={prefs.hasBlockers} onChange={e=>preference({hasBlockers:e.target.checked})}/>有未解除卡点</label><label className="check-line"><input type="checkbox" checked={prefs.includeArchived} onChange={e=>preference({includeArchived:e.target.checked})}/>包含已归档卡片</label><button className="text-button" onClick={()=>preference({status:'',priority:'',tag:'',dueBefore:'',followUpOwner:'',hasBlockers:false,includeArchived:false})}>清除筛选</button></div>}
      {!state.projects.length?<Empty title={currentFolder?'在当前项目创建第一张卡片':'从一个项目开始'} body={currentFolder?`当前目录：${currentFolder}`:projectDiscovery?.status==='unavailable'?'尚无法确认当前目录，请先选择或核验准确项目文件夹。':'登记本机项目文件夹，把目标和进展留在同一处。'}><button className="button primary" onClick={currentFolder?openCreate:()=>setModal({kind:'project'})}>{currentFolder?'新建卡片':'登记项目'}</button></Empty>:prefs.view==='需要我处理'?<div className="inbox">{!notifications.length?<Empty title="暂时没有需要你处理的事" body="待验收、卡点和冲突会集中出现在这里。"><button className="text-button" onClick={()=>preference({view:'全部'})}>查看全部卡片 →</button></Empty>:[...notificationGroups].map(([type,items])=><section className="notification-group" key={type}><h2>{type}<span>{items.length}</span></h2>{items.map(n=>{const card=state.cards.find(c=>c.id===n.cardId)!;const target=card.blockers.find(b=>b.id===n.targetId);return <article className="notification" key={n.id}><button className="notification-main" onClick={()=>{setSelected(n.cardId);if(n.sessionId&&caps.sessions.open&&type.startsWith('卡点'))void sessionAction('open',card,{sessionId:n.sessionId});}}><span className="notification-symbol" aria-hidden="true">{type.startsWith('卡点')?'!':type==='卡片待验收'?'✓':'·'}</span><div><small>{state.projects.find(p=>p.id===n.projectId)?.name} · #{card.no}</small><strong>{card.title}</strong><p>{target?.content??(type==='卡片待验收'?card.progress?.label??'请核对交付内容':type)}</p></div><span>→</span></button><div className="notification-actions"><span>{timeLabel(n.createdAt)}</span>{n.sessionId&&<button className="text-button" disabled={!caps.sessions.open||!!sessionBusy} onClick={()=>void sessionAction('open',card,{sessionId:n.sessionId})}>打开会话</button>}<button className="text-button" onClick={()=>void mutate({type:'notification.resolve',cardId:n.cardId,payload:{notificationId:n.id}})}>标为已处理</button></div></article>;})}</section>)}</div>:prefs.format==='board'?<>
        <p className="keyboard-help">拖动卡片改变状态 · 聚焦卡片后 Alt + ← / → 移列，Alt + ↑ / ↓ 排序</p>
        <div className={`board ${dragging?'is-dragging':''}`} style={dragging?{scrollSnapType:'none',overflowX:'hidden'}:undefined} ref={boardRef} onDragOver={e=>{if(!draggingRef.current)return;e.preventDefault();e.dataTransfer.dropEffect='move';edgeScroll(e.clientX);}} onDragLeave={e=>{if(pointerOutsideBoard(e.currentTarget.getBoundingClientRect(),e.clientX,e.clientY)){stopScroll();setDropTarget(null);}}}>{STATUSES.map(status=>{const column=cards.filter(c=>c.status===status);const collapsed=prefs.collapsed.includes(status);const active=dropTarget?.status===status;return <section className={`board-column ${collapsed?'collapsed':''}`} key={status} data-status={status} data-drop-active={active?'true':undefined} onDragOver={e=>{if(!draggingRef.current)return;e.preventDefault();e.dataTransfer.dropEffect='move';if(!(e.target as Element).closest('.kanban-card'))setDropTarget({status});}} onDragLeave={e=>{if(pointerOutsideBoard(e.currentTarget.getBoundingClientRect(),e.clientX,e.clientY))setDropTarget(current=>current?.status===status?null:current);}} onDrop={e=>{e.preventDefault();e.stopPropagation();void drop(status);}}><header><span className={`status-dot status-${STATUSES.indexOf(status)}`}/><h2>{status}</h2><span className="column-count">{column.length}</span><button aria-label={`${collapsed?'展开':'折叠'}${status}`} onClick={()=>preference({collapsed:collapsed?prefs.collapsed.filter(s=>s!==status):[...prefs.collapsed,status]})}>{collapsed?'＋':'−'}</button></header>{active&&<div className="drop-hint" role="status">{status==='已完成'?'松开后确认完成':`松开放到${status}`}</div>}{!collapsed&&<div className="column-cards">{column.map(c=>renderCard(c,multiple))}{!column.length&&<div className="column-empty">{dragging?'放到这里':'暂无卡片'}</div>}{active&&!dropTarget?.beforeId&&column.length>0&&<div className="drop-end-marker" aria-hidden="true"/>}</div>}</section>;})}</div>
      </>:<div className="table-view"><div className="table-controls"><label>排序<select aria-label="排序字段" value={prefs.sort} onChange={e=>preference({sort:e.target.value as Preferences['sort']})}><option value="order">手动顺序</option><option value="title">标题</option><option value="dueDate">计划交付日</option><option value="followUpAt">跟进时间</option><option value="followUpOwner">跟进人</option><option value="priority">优先级</option><option value="updatedAt">最近更新</option></select></label><button className="icon-button" aria-label="切换排序方向" onClick={()=>preference({direction:prefs.direction==='asc'?'desc':'asc'})}>{prefs.direction==='asc'?'↑':'↓'}</button><label>分组<select aria-label="分组字段" value={prefs.groupBy} onChange={e=>preference({groupBy:e.target.value as Preferences['groupBy']})}><option value="">不分组</option><option value="projectId">项目</option><option value="status">状态</option><option value="priority">优先级</option></select></label><button className="text-button" onClick={()=>setColumnsOpen(!columnsOpen)}>显示列</button></div>{columnsOpen&&<div className="column-options">{Object.entries(COLUMN_LABELS).map(([key,label])=><label className="check-line" key={key}><input type="checkbox" checked={prefs.columns.includes(key)} onChange={()=>preference({columns:prefs.columns.includes(key)?prefs.columns.filter(k=>k!==key):[...prefs.columns,key]})}/>{label}</label>)}</div>}{groupCards(cards,state.projects,prefs.groupBy).map(group=><section className="table-group" key={group.key}>{prefs.groupBy&&<h2>{group.title}<span>{group.cards.length} 张卡片</span></h2>}<div className="table-scroll"><table><thead><tr><th>卡片</th>{prefs.columns.map(key=><th key={key}>{COLUMN_LABELS[key]}</th>)}</tr></thead><tbody>{group.cards.map(card=><tr key={card.id} data-card-id={card.id}><td>{!matchingIds.has(card.id)&&<small className="help">此卡已不匹配筛选；保存或放弃草稿后隐藏。</small>}<small>{multiple?`${state.projects.find(p=>p.id===card.projectId)?.name} · `:''}#{card.no}</small>{editingTitle===card.id?<TableFieldEditor key={`${tableDraftGeneration}:${card.id}:title`} onEditingChange={editing=>trackTableEdit(card,'title',editing)} label={`卡片 #${card.no} 标题`} value={card.title} autoFocus onDone={()=>setEditingTitle(null)} onSave={raw=>{const title=raw.trim();if(!title)throw new Error('标题不能为空。');return update(card,{title});}}/>:<button className="table-title" onClick={()=>setSelected(card.id)}>{card.title}</button>}<select className="table-row-actions" aria-label={`卡片 #${card.no} 快捷操作`} value="" disabled={saving||!!sessionBusy} onChange={e=>{if(e.target.value==='create')setModal({kind:'createSession',card});else if(e.target.value==='bind')void sessionAction('list',card);else if(e.target.value==='title')setEditingTitle(card.id);else if(e.target.value==='edit')setModal({kind:'edit',card});}}><option value="">操作</option><option value="create" disabled={!caps.sessions.create}>新建会话</option><option value="bind" disabled={!caps.sessions.list}>绑定已有会话</option><option value="title">编辑标题</option><option value="edit">编辑卡片</option></select>{card.flags.map(f=><span key={f} className="badge red">{f}</span>)}</td>{prefs.columns.map(key=><td key={key}>{key==='status'?<select aria-label={`卡片 #${card.no} 状态`} value={card.status} onChange={e=>statusChange(card,e.target.value as Status)}>{STATUSES.map(s=><option key={s}>{s}</option>)}</select>:key==='priority'?<select aria-label={`卡片 #${card.no} 优先级`} value={card.priority} onChange={e=>void update(card,{priority:e.target.value})}>{['高','中','低'].map(s=><option key={s}>{s}</option>)}</select>:key==='progress'?<span className="cell-progress">{card.progress?.label??'—'}</span>:<TableFieldEditor key={`${tableDraftGeneration}:${card.id}:${key}`} onEditingChange={editing=>trackTableEdit(card,key,editing)} label={`卡片 #${card.no} ${COLUMN_LABELS[key]}`} value={key==='followUpAt'?followUpInput(card.followUpAt):key==='tags'?card.tags.join('，'):key==='dueDate'?card.dueDate??'':key==='followUpOwner'?card.followUpOwner??'':card.nextStep} type={key==='dueDate'?'date':key==='followUpAt'?'datetime-local':'text'} multiline={key==='nextStep'} onSave={raw=>{const fields=key==='tags'?{tags:raw.split(/[,，]/).map(x=>x.trim()).filter(Boolean)}:key==='followUpAt'?{followUpAt:followUpValue(raw,card.followUpAt)}:key==='dueDate'?{dueDate:raw||null}:key==='followUpOwner'?{followUpOwner:raw.trim()}:{nextStep:raw};return update(card,fields);}}/>}</td>)}</tr>)}</tbody></table></div></section>)}{!cards.length&&<Empty title="没有匹配的卡片" body="试试调整项目或筛选条件。"/>}</div>}
      </>}
    </>
    </div>
    {selectedCard&&<ModalPanel key={selectedCard.id} title="卡片详情" detail inactive={!!modal||!!restoredSnapshot} onClose={requestDetailClose}>{detailClosePrompt&&<div className="detail-unsaved" role="alert" tabIndex={-1}><strong>{saving?'正在保存，请稍候。':'有尚未保存的修改'}</strong><p>{saving?'保存结果返回前，编辑内容会继续保留。':'继续编辑会保留当前内容；放弃修改后关闭详情。'}</p><div className="detail-edit-actions"><button type="button" className="button primary" onClick={()=>setDetailClosePrompt(false)}>继续编辑</button><button type="button" className="button" disabled={saving} onClick={()=>{setDetailDrafts({});setPlanningDraft(null);setDetailClosePrompt(false);setSelected(null);}}>放弃修改</button></div></div>}{error&&<p className="inline-error detail-message" role="alert">{error}</p>}{renderDetail(selectedCard)}</ModalPanel>}
    {renderModal()}
    {restoredSnapshot&&<ModalPanel title="数据已恢复" onClose={()=>{}}><p className="dialog-intro">读取到比当前面板更早的数据版本。采用恢复后的数据后，可以继续保存修改。</p><p className="help">保留草稿只保留正在编辑的内容，确认保存时仅提交修改字段；放弃草稿不会修改恢复后的数据。</p><div className="dialog-footer"><button className="button primary" onClick={()=>adoptRestoredSnapshot(true)}>采用恢复数据，保留草稿</button><button className="button" onClick={()=>adoptRestoredSnapshot(false)}>采用恢复数据，放弃草稿</button></div></ModalPanel>}
  </main>;
}

function shortValue(value:unknown):string {if(value===undefined||value===null)return '空';const text=typeof value==='string'?value:JSON.stringify(value);return text.length>180?text.slice(0,180)+'…':text;}
function RiskList({title,items}:{title:string;items:string[]}){return <section className="risk-list"><h3>{title}<span>{items.length}</span></h3>{items.length?<ul>{items.map((item,i)=><li key={i}>{item}</li>)}</ul>:<p>无</p>}</section>;}
let openModalCount=0;
let previousBodyOverflow='';
function ModalPanel({title,onClose,children,detail=false,inactive=false,returnStatus}:{title:string;onClose:()=>void;children:ReactNode;detail?:boolean;inactive?:boolean;returnStatus?:Status}) {
  const panel=useRef<HTMLDivElement>(null);
  const close=useRef(onClose);close.current=onClose;
  const previousFocus=useRef(document.activeElement as HTMLElement|null);
  const previousCardId=useRef(previousFocus.current?.closest<HTMLElement>('[data-card-id]')?.dataset.cardId);
  const backdropPressed=useRef(false);
  const isTop=()=>Array.from(document.querySelectorAll<HTMLElement>('.modal-panel')).filter(node=>!node.closest('[inert]')).at(-1)===panel.current;
  useEffect(()=>{
    if(openModalCount++===0){previousBodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
    const focusable=()=>Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])')??[]).filter(node=>!node.closest('[inert]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden');
    if(isTop()){
      const auto=panel.current?.querySelector<HTMLElement>('[autofocus]');
      if(!panel.current?.contains(document.activeElement))(auto??focusable()[0]??panel.current)?.focus({preventScroll:true});
    }
    const handler=(e:KeyboardEvent)=>{
      if(!isTop())return;
      if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();close.current();}
      if(e.key==='Tab'){
        const items=focusable();const first=items[0];const last=items.at(-1);
        if(!first){e.preventDefault();panel.current?.focus({preventScroll:true});}
        else if(e.shiftKey&&(document.activeElement===first||!panel.current?.contains(document.activeElement))){e.preventDefault();last?.focus({preventScroll:true});}
        else if(!e.shiftKey&&(document.activeElement===last||!panel.current?.contains(document.activeElement))){e.preventDefault();first.focus({preventScroll:true});}
      }
    };
    document.addEventListener('keydown',handler);
    return()=>{
      if(--openModalCount===0)document.body.style.overflow=previousBodyOverflow;
      document.removeEventListener('keydown',handler);
      queueMicrotask(()=>{
        const previous=previousFocus.current;
        const top=Array.from(document.querySelectorAll<HTMLElement>('.modal-panel')).filter(node=>!node.closest('[inert]')).at(-1);
        if(previous?.isConnected&&!previous.closest('[inert]')&&(!top||top.contains(previous)))previous.focus({preventScroll:true});
        else if(top&&!top.contains(document.activeElement))top.querySelector<HTMLElement>('button:not([disabled])')?.focus({preventScroll:true});
        else if(!top&&previousCardId.current)requestAnimationFrame(()=>{const card=document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(previousCardId.current!)}"]`);const target=card?(card.matches('.kanban-card')?card:card.querySelector<HTMLElement>('.table-title')):returnStatus?document.querySelector<HTMLElement>(`.board-column[data-status="${CSS.escape(returnStatus)}"] header button`):null;const fallback=target??document.querySelector<HTMLElement>('.view-toolbar button,[aria-label="刷新"]');if(fallback&&!fallback.closest('[inert]')){fallback.scrollIntoView({block:'nearest',inline:'nearest'});fallback.focus({preventScroll:true});}});
      });
    };
  },[]);
  return <div className={`modal-backdrop ${detail?'detail-backdrop':''}`} inert={inactive} onPointerDown={e=>{backdropPressed.current=e.target===e.currentTarget;}} onClick={e=>{if(backdropPressed.current&&e.target===e.currentTarget&&isTop())close.current();}}><div className={`modal-panel ${detail?'detail-panel':'form-panel'}`} ref={panel} role="dialog" aria-modal={!inactive} aria-label={title} tabIndex={-1}><header><h2>{title}</h2><button type="button" className={detail?'text-button':'icon-button'} aria-label={detail?'关闭卡片详情':'关闭弹窗'} onClick={()=>close.current()}>{detail?'关闭卡片详情 ×':'×'}</button></header>{children}</div></div>;
}
