import { afterEach, expect, it } from 'vitest';
import { ProjectStore } from './index.ts';
import type { Actor, Event, EventType } from './types.ts';

const stores: ProjectStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new ProjectStore(':memory:'); stores.push(store);
  let seq = 0;
  const apply = (type: EventType, payload: Record<string, unknown> = {}, extra: Partial<Event> = {}) =>
    store.applyEvent({ id: `life-${++seq}`, type, actor: { kind: 'user' }, payload, ...extra });
  apply('project.upsert', { id: 'p', name: '生命周期测试', folder: '/synthetic/lifecycle' });
  const first = apply('card.create', { title: '原卡', acceptance: ['完整验收项'] }, { projectId: 'p' }).cardId!;
  const second = apply('card.create', { title: '新卡' }, { projectId: 'p' }).cardId!;
  apply('session.upsert', { id: 's', projectId: 'p', name: '生命周期会话' });
  apply('session.bind', {}, { sessionId: 's', cardId: first });
  const start = (turnId: string, userMessage = '继续工作', actor: Actor = { kind: 'system' }) =>
    apply('turn.start', { userMessage }, { sessionId: 's', turnId, actor });
  const end = (turnId: string, interrupted = false) =>
    apply('turn.end', { interrupted }, { sessionId: 's', turnId, actor: { kind: 'system' } });
  const report = (turnId: string, payload: Record<string, unknown> = { noChange: true }) =>
    apply('report.submit', payload, { sessionId: 's', turnId, actor: { kind: 'session', id: 's' } });
  const card = (id = first) => store.getState().cards.find(c => c.id === id)!;
  const session = () => store.getState().sessions.find(s => s.id === 's')!;
  return { store, apply, first, second, start, end, report, card, session };
}

it('C-144 Stop缺失且旧轮漏报时新轮可开启并在正常报告后清标（核心回归）', () => {
  const x = fixture(); expect(x.start('t1').ok).toBe(true);
  expect(x.start('t2').ok).toBe(true);
  expect(x.session().turn).toMatchObject({ id: 't2', number: 2, reported: false });
  expect(x.card().needsSync).toBe(true);
  expect(x.store.getState().activities.some(a => a.summary.includes('第 1 轮没有报告'))).toBe(true);
  expect(x.report('t2', { fields: { progressText: '新轮已回报' } }).ok).toBe(true);
  expect(x.card().needsSync).toBe(false);
  expect(x.card().progressText).toBe('新轮已回报');
  expect(x.store.getState().activities.some(a => a.summary.includes('第 1 轮没有报告'))).toBe(true);
});

it('C-143 Stop缺失但旧轮已报告时换轮不误标漏报（核心回归）', () => {
  const x = fixture(); x.start('t1'); expect(x.report('t1').ok).toBe(true);
  expect(x.start('t2').ok).toBe(true);
  expect(x.session().turn?.id).toBe('t2'); expect(x.card().needsSync).toBe(false);
  expect(x.store.getState().activities.some(a => a.summary.includes('没有报告'))).toBe(false);
  expect(x.store.getState().activities.at(-1)?.summary).toContain('已报告');
});

it('C-126 Stop缺失后换轮应用pending换绑且旧报告不能写新卡（核心回归）', () => {
  const x = fixture(); x.start('t1'); x.report('t1', { fields: { progressText: '原卡报告' } });
  x.apply('session.bind', { confirmed: true }, { sessionId: 's', cardId: x.second });
  expect(x.session().cardId).toBe(x.first);
  expect(x.start('t2').ok).toBe(true);
  expect(x.session()).toMatchObject({ cardId: x.second, turn: { id: 't2', cardId: x.second } });
  expect(x.session().pendingCardId).toBeUndefined();
  expect(x.card().progressText).toBe('原卡报告'); expect(x.card(x.second).progressText).toBe('');
  expect(x.report('t1', { fields: { progressText: '过期报告' } }).ok).toBe(false);
  expect(x.card(x.second).progressText).toBe('');
  expect(x.report('t2', { fields: { progressText: '新卡报告' } }).ok).toBe(true);
  x.end('t2');
  expect(x.report('t1', { fields: { progressText: '更晚的旧报告' } }).ok).toBe(false);
  expect(x.card(x.second).progressText).toBe('新卡报告');
});

it('C-142 Stop缺失且换绑时漏报标记留在原卡（核心回归）', () => {
  const x = fixture(); x.start('t1');
  x.apply('session.bind', { confirmed: true }, { sessionId: 's', cardId: x.second });
  expect(x.start('t2').ok).toBe(true);
  expect(x.card().needsSync).toBe(true); expect(x.card(x.second).needsSync).toBe(false);
  x.report('t2'); expect(x.card().needsSync).toBe(true);
});

it.each<Actor>([{ kind: 'user' }, { kind: 'session', id: 's' }, { kind: 'user_instruction', id: 's' }])(
  'C-142 只有system可以开启回合：%j（核心回归）', actor => {
    const x = fixture(); expect(x.start('forged', '这个算完成了', actor).ok).toBe(false);
    expect(x.session().turn).toBeUndefined();
  },
);

it('C-062 晚到旧Stop不能删除新回合的用户原话（核心回归）', () => {
  const x = fixture(); x.start('t1'); x.end('t1'); x.start('t2', '这个算完成了');
  expect(x.end('t1').ok).toBe(false);
  expect(x.apply('instruction.apply', { quote: '这个算完成了', action: 'complete' }, {
    actor: { kind: 'user_instruction', id: 's' }, sessionId: 's', turnId: 't2', cardId: x.first,
  }).ok).toBe(true);
  expect(x.card().status).toBe('已完成');
});

it('C-145 已知中断回合换轮不误记漏报且保留卡点（核心回归）', () => {
  const x = fixture(); x.apply('checklist.add', { list: 'blockers', content: '等资料', blocking: true }, { cardId: x.first });
  x.start('t1'); expect(x.end('t1', true).ok).toBe(true); expect(x.start('t2').ok).toBe(true);
  expect(x.card().needsSync).toBe(false); expect(x.card().status).toBe('未开始');
  expect(x.card().flags).toContain('阻塞');
  expect(x.store.getState().activities.some(a => a.summary.includes('被中断'))).toBe(true);
});

it('C-146 已收尾旧turn.start重送不能把当前回合倒退（核心回归）', () => {
  const x = fixture(); x.start('t1'); x.end('t1'); x.start('t2'); x.end('t2');
  expect(x.start('t1').ok).toBe(false); expect(x.session().turn).toBeUndefined();
});
