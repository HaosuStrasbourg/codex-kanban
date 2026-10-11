import type {Card,Session,State} from '../../core/src/types.ts';
import {KnownToolError} from './client.ts';
import type {Client,UIEvent} from './client.ts';
export type SessionLinkFilter='all'|'unbound'|'bound';
export function selectProjectSessions(sessions:Session[],projectIds:string[]|'all',query:string,link:SessionLinkFilter):Session[]{
  const term=query.trim().toLocaleLowerCase();
  return sessions.filter(session=>(projectIds==='all'||projectIds.includes(session.projectId))&&(!term||session.name.toLocaleLowerCase().includes(term))&&(link==='all'||(link==='bound'?!!(session.cardId||session.pendingCardId):!(session.cardId||session.pendingCardId))))
    .sort((a,b)=>(Date.parse(b.lastActivityAt)||0)-(Date.parse(a.lastActivityAt)||0)||a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));
}
export function sessionCardChoices(cards:Card[],projectId:string):Card[]{return cards.filter(card=>card.projectId===projectId&&!card.deleted);}
/** One explicit session-to-card draft survives both unknown saves and later binding failures. */
export class SessionCardDrafts {
  private drafts=new Map<string,{event:UIEvent;card?:Card;state?:State}>();
  constructor(private client:Pick<Client,'apply'>){}
  get(sessionId:string){return this.drafts.get(sessionId);}
  complete(sessionId:string){this.drafts.delete(sessionId);}
  async create(session:Session,title:string,planning?:Pick<Card,'followUpOwner'|'followUpAt'|'dueDate'>):Promise<{card:Card;state:State}>{
    let draft=this.drafts.get(session.id);
    if(!draft){draft={event:{id:crypto.randomUUID(),type:'card.create',projectId:session.projectId,payload:{title:title.trim(),...planning}}};this.drafts.set(session.id,draft);}
    if(draft.card&&draft.state)return {card:draft.card,state:draft.state};
    const reply=await this.client.apply(draft.event);
    if(!reply?.result||typeof reply.result.ok!=='boolean'||!reply.state)throw new Error('建卡结果尚未确认，重试会核对原请求。');
    if(!reply.result.ok){this.drafts.delete(session.id);throw new KnownToolError(reply.result.errors.join('；')||'卡片未创建。',reply.state);}
    const card=reply.state.cards.find(card=>card.id===reply.result.cardId);
    if(!card)throw new Error('建卡结果缺少卡片，重试会核对原请求。');
    draft.card=card;draft.state=reply.state;return {card,state:reply.state};
  }
}
