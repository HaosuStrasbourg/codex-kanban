import {describe,expect,it} from 'vitest';
import * as view from './view-model.ts';
import type {Card,State,Activity} from '../../core/src/types.ts';

const card=(id:string,patch:Partial<Card>={})=>({id,projectId:'p1',no:1,title:id,status:'未开始',priority:'中',tags:[],dueDate:null,followUpOwner:'我',followUpAt:null,archived:false,deleted:false,order:0,updatedAt:'2026-10-05T00:00:00Z',blockers:[],acceptance:[],conflicts:[],...patch} as Card);
const state=(cards:Card[])=>({cards,projects:[{id:'p1',name:'合成项目'},{id:'p2',name:'其他项目'}],notifications:[]} as unknown as State);
describe('计划与跟进 UI 模型（合成数据）',()=>{
  it('C-430 六状态顺序固定，键盘移动经过计划中',()=>{
    expect(view.STATUSES).toEqual(['未开始','计划中','进行中','待验收','已完成','暂停']);
    expect(view.nextStatus('未开始',1)).toBe('计划中');expect(view.nextStatus('进行中',-1)).toBe('计划中');
  });
  it('C-431 跟进时间输入显式转北京时间，UTC/其他偏移显示同一时刻',()=>{
    expect(view.followUpISO('2026-10-06T00:15')).toBe('2026-10-06T00:15:00+08:00');
    expect(view.followUpInput('2026-10-05T16:15:00Z')).toBe('2026-10-06T00:15');
    expect(view.followUpInput('2026-10-05T09:15:00-07:00')).toBe('2026-10-06T00:15');
    expect(view.followUpISO('')).toBeNull();expect(view.followUpInput(null)).toBe('');
  });
  it('C-431 秒数保护：编辑其他字段或表格仅失焦保留原ISO，明确改时间才转换',()=>{
    const original='2026-10-06T01:30:27.123Z';const shown=view.followUpInput(original);
    expect(view.followUpValue(shown,original)).toBe(original);
    const offset='2026-10-05T18:30:59-07:00';expect(view.followUpValue(view.followUpInput(offset),offset)).toBe(offset);
    expect(view.followUpValue('2026-10-07T14:45',original)).toBe('2026-10-07T14:45:00+08:00');
    expect(view.followUpValue('',original)).toBeNull();
  });
  it('C-432 输入拒绝不存在日期与机器本地偏移猜测',()=>{
    expect(typeof view.followUpISO).toBe('function');
    expect(()=>view.followUpISO('2026-02-30T10:00')).toThrow();expect(()=>view.followUpISO('2026-10-06T24:00')).toThrow();
    expect(()=>view.followUpISO('2026-10-06')).toThrow();
  });
  it('C-433 今天需跟进按北京时间跨日，包含当天稍晚和此前日期',()=>{
    const s=state([card('today',{followUpAt:'2026-10-06T22:00:00+08:00'}),card('before',{followUpAt:'2026-10-05T09:00:00+08:00'}),card('tomorrow',{followUpAt:'2026-10-07T00:00:00+08:00'}),card('none')]);
    expect(view.selectCards(s,{view:'今天需跟进'},new Date('2026-10-05T16:01:00Z')).map(c=>c.id)).toEqual(['today','before']);
    expect(view.selectCards(s,{view:'今天需跟进'},new Date('2026-10-05T15:59:00Z')).map(c=>c.id)).toEqual(['before']);
  });
  it('C-434 两行动视图始终排除完成/归档/删除，保留暂停且遵守项目范围',()=>{
    const s=state([card('paused',{status:'暂停',followUpAt:'2026-10-05T09:00:00+08:00',dueDate:'2026-10-05'}),card('done',{status:'已完成',followUpAt:'2026-10-05T09:00:00+08:00',dueDate:'2026-10-05'}),card('archived',{archived:true,followUpAt:'2026-10-05T09:00:00+08:00',dueDate:'2026-10-05'}),card('deleted',{deleted:true,followUpAt:'2026-10-05T09:00:00+08:00',dueDate:'2026-10-05'}),card('foreign',{projectId:'p2',followUpAt:'2026-10-05T09:00:00+08:00',dueDate:'2026-10-05'})]);
    for(const actionView of ['今天需跟进','逾期事项'] as const)expect(view.selectCards(s,{view:actionView,includeArchived:true,projectIds:['p1']},new Date('2026-10-06T00:00:00+08:00')).map(c=>c.id)).toEqual(['paused']);
  });
  it('C-435 逾期交付不包含当天，计划中照常计入',()=>{
    const s=state([card('late',{status:'计划中',dueDate:'2026-10-05'}),card('today',{dueDate:'2026-10-06'}),card('future',{dueDate:'2026-10-07'}),card('none')]);
    expect(view.selectCards(s,{view:'逾期事项'},new Date('2026-10-05T16:00:00Z')).map(c=>c.id)).toEqual(['late']);
  });
  it('C-436 跟进时间按实际时刻排序而非ISO字符串，支持跟进人筛选',()=>{
    const s=state([card('later',{followUpOwner:'我',followUpAt:'2026-10-06T10:00:00+08:00'}),card('earlier',{followUpOwner:'同事',followUpAt:'2026-10-06T01:00:00Z'}),card('unset',{followUpOwner:'我'})]);
    expect(view.selectCards(s,{sort:'followUpAt',direction:'asc'}).map(c=>c.id)).toEqual(['earlier','later','unset']);
    expect(view.selectCards(s,{followUpOwner:'我'}).map(c=>c.id)).toEqual(['later','unset']);
  });
  it('C-437 偏好恢复识别行动视图与计划中，新表格默认显示跟进字段',()=>{
    expect(view.restoredPreferences({view:'今天需跟进',status:'计划中',sort:'followUpAt',followUpOwner:'我'})).toMatchObject({view:'今天需跟进',status:'计划中',sort:'followUpAt',followUpOwner:'我'});
    expect(view.defaultPreferences.columns).toEqual(expect.arrayContaining(['followUpOwner','followUpAt','dueDate']));
    expect(view.restoredPreferences({columns:['status','priority','dueDate','progress','tags']}).columns).toEqual(view.defaultPreferences.columns);
    expect(view.restoredPreferences({columns:['status','tags']}).columns).toEqual(['status','tags']);
  });
  it('C-438 活动将字段显示为跟进人/北京时间/计划交付日',()=>{
    const a={type:'card.update',summary:'card.update',changes:[{collection:'cards',id:'c',field:'followUpOwner',before:'',after:'我'},{collection:'cards',id:'c',field:'followUpAt',before:null,after:'2026-10-05T16:00:00Z'},{collection:'cards',id:'c',field:'dueDate',before:null,after:'2026-10-07'}]} as Activity;
    const text=view.presentActivity(a).changes.join('\n');expect(text).toContain('跟进人：未设置 → 我');expect(text).toContain('跟进时间（北京时间）');expect(text).toContain('计划交付日');expect(text).not.toContain('2026-10-05T16:00:00Z');
  });
  it('C-439 所有时间标签明确采用北京时间',()=>{expect(view.timeLabel('2026-10-05T16:15:00Z')).toMatch(/10[/-]06.*00:15/);});
});
