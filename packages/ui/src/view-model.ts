import type { Activity, Card, EventType, Project, State, Status, Priority } from '../../core/src/types.ts';
import {businessDate,matchesFollowUpView} from '../../core/src/dates.ts';
export const STATUSES: Status[] = ['未开始','计划中','进行中','待验收','已完成','暂停'];
export const VIEWS = ['需要我处理','今天需跟进','逾期事项','进行中','本周到期','全部'] as const;
export interface Preferences {
  projectIds: string[] | 'all'; view: typeof VIEWS[number]; format: 'board'|'table';
  status: Status | ''; priority: Priority | ''; tag: string; dueBefore: string; followUpOwner:string; hasBlockers: boolean;
  includeArchived: boolean; sort: 'order'|'title'|'dueDate'|'priority'|'updatedAt'|'followUpOwner'|'followUpAt'; direction:'asc'|'desc';
  groupBy: ''|'projectId'|'status'|'priority'; columns: string[]; collapsed: Status[];
}
export const defaultPreferences: Preferences = {projectIds:'all',view:'需要我处理',format:'board',status:'',priority:'',tag:'',dueBefore:'',followUpOwner:'',hasBlockers:false,includeArchived:false,sort:'order',direction:'asc',groupBy:'',columns:['status','followUpOwner','followUpAt','dueDate','priority','progress','tags'],collapsed:[]};
export function restoredPreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== 'object') return {...defaultPreferences};
  const r = raw as Partial<Preferences>;
  return {...defaultPreferences,...r,
    view:VIEWS.includes(r.view as never)?r.view!:defaultPreferences.view,
    projectIds:r.projectIds === 'all'||Array.isArray(r.projectIds)?r.projectIds:'all',
    format:r.format==='table'?'table':'board',
    status:STATUSES.includes(r.status as Status)?r.status!:'',
    priority:['高','中','低'].includes(r.priority??'')?r.priority!:'',
    followUpOwner:typeof r.followUpOwner==='string'?r.followUpOwner:'',
    columns:Array.isArray(r.columns)&&JSON.stringify(r.columns)!==JSON.stringify(['status','priority','dueDate','progress','tags'])?r.columns:defaultPreferences.columns,
    collapsed:Array.isArray(r.collapsed)?r.collapsed.filter(x=>STATUSES.includes(x)):[],
  };
}
export function selectCards(state:State,p:Partial<Preferences>,now=new Date()): Card[] {
  const monday=new Date(businessDate(now)+'T00:00:00Z');monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
  const sunday=new Date(monday);sunday.setUTCDate(sunday.getUTCDate()+7);
  const pending=new Set(state.notifications.filter(n=>n.status==='待处理').map(n=>n.cardId));
  const cards=state.cards.filter(c=>!c.deleted&&(!c.archived||p.includeArchived)
    &&(!p.projectIds||p.projectIds==='all'||p.projectIds.includes(c.projectId))
    &&(p.view!=='进行中'||c.status==='进行中')
    &&(p.view!=='需要我处理'||pending.has(c.id))
    &&(p.view!=='本周到期'||(c.status!=='已完成'&&!!c.dueDate&&new Date(c.dueDate+'T00:00:00Z')>=monday&&new Date(c.dueDate+'T00:00:00Z')<sunday))
    &&((p.view!=='今天需跟进'&&p.view!=='逾期事项')||matchesFollowUpView(c,p.view,now))
    &&(!p.status||c.status===p.status)&&(!p.priority||c.priority===p.priority)
    &&(!p.followUpOwner||c.followUpOwner===p.followUpOwner)
    &&(!p.tag||c.tags.includes(p.tag))&&(!p.dueBefore||(!!c.dueDate&&c.dueDate<=p.dueBefore))
    &&(!p.hasBlockers||c.blockers.some(b=>!b.checked)));
  const priority={高:0,中:1,低:2};
  return cards.sort((a,b)=>{
    let diff=0;
    if(p.sort==='priority')diff=priority[a.priority]-priority[b.priority];
    else if(p.sort==='title')diff=a.title.localeCompare(b.title,'zh-CN');
    else if(p.sort==='dueDate')diff=(a.dueDate??'9999').localeCompare(b.dueDate??'9999');
    else if(p.sort==='followUpOwner')diff=(a.followUpOwner??'').localeCompare(b.followUpOwner??'','zh-CN');
    else if(p.sort==='followUpAt')diff=(a.followUpAt?Date.parse(a.followUpAt):Number.MAX_SAFE_INTEGER)-(b.followUpAt?Date.parse(b.followUpAt):Number.MAX_SAFE_INTEGER);
    else if(p.sort==='updatedAt')diff=a.updatedAt.localeCompare(b.updatedAt);
    else diff=a.order-b.order;
    return p.direction==='desc'?-diff:diff;
  });
}
export function groupCards(cards:Card[],projects:Project[],field:Preferences['groupBy']) {
  if(!field)return [{key:'all',title:'全部卡片',cards}];
  const groups=new Map<string,Card[]>();
  for(const card of cards){const key=card[field];groups.set(key,[...(groups.get(key)??[]),card]);}
  return [...groups].map(([key,items])=>({key,title:field==='projectId'?(projects.find(x=>x.id===key)?.name??'未命名项目'):key,cards:items}));
}
export function completionRisks(card:Card) {return {unaccepted:card.acceptance.filter(x=>!x.checked).length,blockers:card.blockers.filter(x=>!x.checked).length,conflicts:card.conflicts.filter(x=>!x.resolved).length};}
export function nextStatus(status:Status,direction:number):Status {return STATUSES[Math.max(0,Math.min(STATUSES.length-1,STATUSES.indexOf(status)+direction))]!;}
/** Native dragleave also fires between descendants and while content scrolls. */
export function pointerOutsideBoard(rect:{left:number;right:number;top:number;bottom:number},x:number,y:number):boolean {return x<rect.left||x>rect.right||y<rect.top||y>rect.bottom;}
export function safeExternalLink(link:string):string|null {return /^https?:\/\//i.test(link)?link:null;}
export function timeLabel(value:string|null|undefined):string {if(!value)return '尚未同步'; const d=new Date(value);return Number.isNaN(d.getTime())?'时间未知':d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
export function followUpInput(value:string|null|undefined):string {
  if(!value||!Number.isFinite(Date.parse(value)))return '';
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  return `${businessDate(value)}T${time}`;
}
export function followUpValue(value:string,previous:string|null|undefined):string|null {return value===followUpInput(previous)?previous??null:followUpISO(value);}
export function followUpISO(value:string):string|null {
  if(!value.trim())return null;
  const iso=`${value}:00+08:00`;
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)||followUpInput(iso)!==value)throw new Error('跟进时间无效，请输入北京时间。');
  return iso;
}

const EVENT_LABELS:Partial<Record<EventType,string>>={
  'project.upsert':'登记项目','card.create':'新建卡片','card.update':'修改卡片','card.archive':'调整卡片归档','card.delete':'删除卡片','card.complete':'确认完成','card.reorder':'调整卡片顺序',
  'checklist.add':'新增清单项','checklist.update':'修改清单项','checklist.delete':'删除清单项','checklist.check':'更新清单勾选','acceptance.evidence':'添加验收证据','acceptance.reject':'不认可验收证据','blocker.resolve':'解除卡点',
  'artifact.add':'添加成果','artifact.delete':'移除成果','session.upsert':'更新会话状态','session.bind':'绑定会话','session.unbind':'解绑会话','session.create_failed':'会话创建失败',
  'turn.start':'开始本轮工作','turn.end':'结束本轮工作','report.submit':'更新进展报告','instruction.apply':'按我的对话指令修改','notification.resolve':'标为已处理','activity.undo':'撤销修改','comment.add':'添加备注','preferences.update':'调整视图','sync.missing':'标记待补同步','sync.failed':'同步失败','sync.recovered':'恢复同步','store.restore':'恢复备份',
};
const FIELD_LABELS:Record<string,string>={title:'标题',description:'描述',tags:'标签',priority:'优先级',dueDate:'计划交付日',followUpOwner:'跟进人',followUpAt:'跟进时间（北京时间）',status:'状态',progressText:'最新进展',nextStep:'下一步',archived:'已归档',deleted:'已删除',checklist:'检查清单',acceptance:'验收清单',blockers:'卡点',artifacts:'成果',members:'成员',flags:'提示标记',progress:'验收进度',needsSync:'待补同步',sessionCreationError:'会话创建结果',name:'名称',folder:'项目文件夹',conflicts:'冲突'};
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'?value as Record<string,unknown>:{};}
function textValue(value:unknown):string{
  if(value===undefined||value===null||value==='')return '未设置';
  if(typeof value==='boolean')return value?'是':'否';
  if(Array.isArray(value))return value.length?value.map(textValue).join('、'):'无';
  if(typeof value==='object'){const r=record(value);return textValue(r.label??r.content??r.title??r.name??'已更新');}
  return String(value);
}
function evidenceText(value:unknown):string {return Array.isArray(value)&&value.length?value.map(e=>{const r=record(e);return `${textValue(r.reference)}${r.detail?`（${textValue(r.detail)}）`:''}`;}).join('；'):'无';}
function itemText(item:Record<string,unknown>,field:string):string {
  const name=textValue(item.content??item.title??item.name);
  if(field==='artifacts')return `${name} · ${textValue(item.link)}`;
  if(field==='members')return `${name} · ${textValue(item.role)} · ${textValue(item.status)}`;
  if(field==='conflicts')return `${FIELD_LABELS[String(item.field)]??'内容'}：当前「${textValue(item.current)}」，建议「${textValue(item.proposed)}」`;
  const state=field==='acceptance'?item.acceptanceState??(item.checked?'已验收':'未验收'):field==='blockers'?(item.checked?'已解除':'未解除'):(item.checked?'已完成':'未完成');
  const details=[state,field==='blockers'?`${item.blocking?'阻断':'非阻断'} · 等${item.waitingFor??'我'}`:'',Array.isArray(item.evidence)&&item.evidence.length?`证据：${evidenceText(item.evidence)}`:'',item.resolution?`解除依据：${textValue(item.resolution)}`:''].filter(Boolean).join(' · ');
  return `${name}${details?`（${details}）`:''}`;
}
function listChanges(field:string,before:unknown,after:unknown):string[]{
  const label=FIELD_LABELS[field]??'内容';const oldList=Array.isArray(before)?before.map(record):[];const newList=Array.isArray(after)?after.map(record):[];const lines:string[]=[];
  const identity=(item:Record<string,unknown>)=>item.id??item.sessionId;
  for(const old of oldList){if(!newList.some(item=>identity(item)===identity(old)))lines.push(`${label}：${itemText(old,field)} → 已移除`);}
  for(const item of newList){
    const old=oldList.find(previous=>identity(previous)===identity(item));
    if(!old){lines.push(`${label}：无 → ${itemText(item,field)}`);continue;}
    const name=textValue(item.content??item.title??item.name);const prefix=`${label}「${name}」`;
    for(const [key,title] of [['content','内容'],['title','标题'],['link','链接'],['name','名称'],['role','角色'],['status','状态'],['blocking','是否阻断'],['waitingFor','在等谁'],['resolution','解除依据']] as const){if(JSON.stringify(old[key])!==JSON.stringify(item[key]))lines.push(`${prefix}${title}：${textValue(old[key])} → ${textValue(item[key])}`);}
    const beforeState=field==='acceptance'?old.acceptanceState??(old.checked?'已验收':'未验收'):field==='blockers'?(old.checked?'已解除':'未解除'):(old.checked?'已完成':'未完成');
    const afterState=field==='acceptance'?item.acceptanceState??(item.checked?'已验收':'未验收'):field==='blockers'?(item.checked?'已解除':'未解除'):(item.checked?'已完成':'未完成');
    if(['acceptance','checklist','blockers'].includes(field)&&beforeState!==afterState)lines.push(`${prefix}：${beforeState} → ${afterState}`);
    if(JSON.stringify(old.evidence)!==JSON.stringify(item.evidence))lines.push(`${prefix}证据：${evidenceText(old.evidence)} → ${evidenceText(item.evidence)}`);
    if(old.rejected!==item.rejected)lines.push(`${prefix}证据认可：${old.rejected?'不认可':'未否决'} → ${item.rejected?'不认可':'未否决'}`);
    if(field==='conflicts'&&old.resolved!==item.resolved)lines.push(`${label}：${itemText(item,field)} · ${old.resolved?'已解决':'未解决'} → ${item.resolved?'已解决':'未解决'}`);
  }
  return lines;
}
export function presentActivity(activity:Activity):{title:string;changes:string[]}{
  const changes:string[]=[];
  for(const change of activity.changes){
    const field=change.field;if(!field||!FIELD_LABELS[field])continue;
    if(['checklist','acceptance','blockers','artifacts','members','conflicts'].includes(field))changes.push(...listChanges(field,change.before,change.after));
    else if(field==='followUpAt')changes.push(`${FIELD_LABELS[field]}：${change.before?followUpInput(String(change.before)).replace('T',' '):'未设置'} → ${change.after?followUpInput(String(change.after)).replace('T',' '):'未设置'}`);
    else changes.push(`${FIELD_LABELS[field]}：${textValue(change.before)} → ${textValue(change.after)}`);
  }
  return {title:activity.summary&&activity.summary!==activity.type?activity.summary:EVENT_LABELS[activity.type]??'更新卡片',changes};
}
