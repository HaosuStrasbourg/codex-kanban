import { describe, expect, it } from 'vitest';
import { completionRisks, selectCards, nextStatus, restoredPreferences, groupCards, presentActivity, pointerOutsideBoard } from './view-model.ts';
import type { Activity, Card, State } from '../../core/src/types.ts';

const card = (id: string, projectId: string, status = '进行中', dueDate: string | null = null) => ({ id, projectId, no: 1, title: id, status, dueDate, priority: '中', tags: [], archived: false, deleted: false, order: 0, blockers: [], acceptance: [], conflicts: [] } as unknown as Card);
const state = { cards: [card('a','p1'),card('b','p2','未开始','2026-10-09'),card('c','p1','已完成','2026-10-09')], projects:[{id:'p1',name:'账号体系'},{id:'p2',name:'经营分析'}], notifications:[] } as unknown as State;

describe('UI 状态合同（局部，不替代真实宿主界面验收）', () => {
  it('C-221 界面局部：完成前风险包含未验收、卡点与冲突', () => {
    const target = {...state.cards[0]!, acceptance:[{checked:false},{checked:true}], blockers:[{checked:false}],conflicts:[{resolved:false}]} as Card;
    expect(completionRisks(target)).toEqual({unaccepted:1,blockers:1,conflicts:1});
    expect(nextStatus('待验收',1)).toBe('已完成');
  });
  it('C-224 界面局部：各视图随项目选择过滤且本周排除已完成', () => {
    expect(selectCards(state,{view:'进行中',projectIds:['p1']},new Date('2026-10-05T12:00:00')).map(x=>x.id)).toEqual(['a']);
    expect(selectCards(state,{view:'本周到期',projectIds:'all'},new Date('2026-10-05T12:00:00')).map(x=>x.id)).toEqual(['b']);
    expect(selectCards(state,{view:'全部',projectIds:['p2']}).map(x=>x.id)).toEqual(['b']);
  });
  it('C-225 界面局部：重开恢复筛选并拒绝未知视图', () => {
    expect(restoredPreferences({view:'进行中',projectIds:['p1'],format:'table',priority:'高'})).toMatchObject({view:'进行中',projectIds:['p1'],format:'table',priority:'高'});
    expect(restoredPreferences({view:'伪造视图',format:'unknown'}).view).toBe('需要我处理');
  });
  it('C-226 界面局部：按项目分组返回可见数量', () => {
    expect(groupCards(state.cards,state.projects,'projectId').map(x=>[x.title,x.cards.length])).toEqual([['账号体系',2],['经营分析',1]]);
  });
  it('C-141 界面局部：活动保留业务字段改前改后，隐藏内部版本与更新时间字段',()=>{
    const activity={type:'report.submit',summary:'report.submit',changes:[{collection:'cards',id:'card-private-id',field:'progressText',before:'尚未开工',after:'已整理五家竞品'},{collection:'cards',id:'card-private-id',field:'nextStep',before:'调研',after:'编写注销条件'},{collection:'cards',id:'card-private-id',field:'updatedAt',before:'a',after:'b'}]} as Activity;
    expect(presentActivity(activity)).toEqual({title:'更新进展报告',changes:['最新进展：尚未开工 → 已整理五家竞品','下一步：调研 → 编写注销条件']});
  });
  it('UI-DISPLAY 额外检查：清单活动展示条目和证据变化，不暴露JSON或内部ID',()=>{
    const before={id:'item-private-id',content:'覆盖合规依据',checked:false,evidence:[],acceptanceState:'未验收',rejected:false};
    const after={...before,checked:true,acceptanceState:'已验收',evidence:[{kind:'document',reference:'/project/PRD.md',detail:'第3章'}]};
    const activity={type:'checklist.check',summary:'checklist.check',changes:[{collection:'cards',id:'card-private-id',field:'acceptance',before:[before],after:[after]}]} as Activity;
    const shown=presentActivity(activity);
    expect(shown.title).toBe('更新清单勾选');
    expect(shown.changes).toContain('验收清单「覆盖合规依据」：未验收 → 已验收');
    expect(shown.changes.join('\n')).toContain('证据：无 → /project/PRD.md（第3章）');
    expect(JSON.stringify(shown)).not.toContain('private-id');
    expect(JSON.stringify(shown)).not.toContain('acceptanceState');
  });
  it('UI-DRAG 额外检查：拖过子元素触发leave时，指针仍在看板内不能停止边缘滚动',()=>{
    const board={left:0,right:340,top:280,bottom:900};
    expect(pointerOutsideBoard(board,288,400)).toBe(false);
    expect(pointerOutsideBoard(board,336,400)).toBe(false);
    expect(pointerOutsideBoard(board,340,400)).toBe(false);
    expect(pointerOutsideBoard(board,341,400)).toBe(true);
    expect(pointerOutsideBoard(board,-1,400)).toBe(true);
    expect(pointerOutsideBoard(board,336,279)).toBe(true);
    expect(pointerOutsideBoard(board,336,901)).toBe(true);
  });
});
