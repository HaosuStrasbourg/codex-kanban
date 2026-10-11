import {describe,expect,it} from 'vitest';
import type {Session,State} from '../../core/src/types.ts';
import {ProjectStore} from '../../core/src/index.ts';
import {SessionCardDrafts,selectProjectSessions,sessionCardChoices} from './session-catalog.ts';

describe('独立会话视图（合成数据，仅 UI 局部）',()=>{
  const sessions=[{id:'old',projectId:'p1',name:'账户 PRD',status:'空闲',lastActivityAt:'2026-10-01T00:00:00Z'},{id:'new',projectId:'p1',name:'账户评审',status:'运行中',lastActivityAt:'2026-10-05T00:00:00Z',cardId:'c1'},{id:'foreign',projectId:'p2',name:'账户讨论',status:'空闲',lastActivityAt:'2026-10-06T00:00:00Z'}] as Session[];
  it('C-301 项目会话独立显示：按项目、名称、关联状态筛选，活动倒序',()=>{
    expect(selectProjectSessions(sessions,['p1'],'账户','all').map(s=>s.id)).toEqual(['new','old']);
    expect(selectProjectSessions(sessions,'all','prd','unbound').map(s=>s.id)).toEqual(['old']);
    expect(selectProjectSessions(sessions,['p1'],'','bound').map(s=>s.id)).toEqual(['new']);
    expect(selectProjectSessions(sessions,[],'','all')).toEqual([]);
  });
  it('C-302 关联候选仅限同项目未删除卡片，原卡片允许展示',()=>{
    const cards=[{id:'a',projectId:'p1',deleted:false},{id:'b',projectId:'p2',deleted:false},{id:'c',projectId:'p1',deleted:true}] as State['cards'];
    expect(sessionCardChoices(cards,'p1').map(c=>c.id)).toEqual(['a']);
  });
  it('C-303 手动建卡：响应丢失后原 ID 重试，明确已创建后绑定失败也不再建卡',async()=>{
    const store=new ProjectStore(':memory:');
    try{
      store.applyEvent({id:'p',type:'project.upsert',actor:{kind:'user'},payload:{id:'p1',name:'合成项目',folder:'/synthetic/project'}});
      let lost=true;const ids:string[]=[];
      const drafts=new SessionCardDrafts({apply:async event=>{ids.push(event.id);const result=store.applyEvent({...event,actor:{kind:'user'}});if(lost){lost=false;throw new Error('创建响应丢失');}return {result,state:store.getState()};}});
      await expect(drafts.create(sessions[0]!,'可编辑的新卡片')).rejects.toThrow('响应丢失');
      const recovered=await drafts.create(sessions[0]!,'第二次输入不能重复建卡');expect(recovered.card.title).toBe('可编辑的新卡片');
      await drafts.create(sessions[0]!,'关联失败重试');expect(store.getState().cards).toHaveLength(1);expect(ids).toHaveLength(2);expect(ids[0]).toBe(ids[1]);
    }finally{store.close();}
  });
});
