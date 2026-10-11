import { afterEach, expect, it } from 'vitest';
import { ProjectStore } from './store.ts';
import type { Actor, Event, EventType } from './types.ts';

const stores: ProjectStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const assistant: Actor = { kind: 'assistant', id: 'issuer', name: 'AI 代办' };
function fixture() {
  const store = new ProjectStore(':memory:'); stores.push(store); let seq = 0;
  const user = (type: EventType, payload: Record<string, unknown> = {}, extra: Partial<Event> = {}) =>
    store.applyEvent({ id: `setup-${++seq}`, type, actor: { kind: 'user' }, payload, ...extra });
  for (const id of ['p', 'q']) user('project.upsert', { id, name: id, folder: `/synthetic/${id}` });
  for (const [id, projectId] of [['issuer', 'p'], ['target', 'p'], ['main', 'p'], ['foreign', 'q']])
    user('session.upsert', { id, projectId, name: id });
  for (const [id, projectId] of [['a', 'p'], ['b', 'p'], ['c', 'p'], ['other', 'q']])
    user('card.create', { id, title: id, acceptance: ['用户验收'] }, { projectId });
  const act = (type: EventType, payload: Record<string, unknown> = {}, extra: Partial<Event> = {}) =>
    store.applyEvent({ id: `assistant-${++seq}`, type, actor: assistant, projectId: 'p', payload, ...extra });
  const bind = (cardId: string, payload: Record<string, unknown> = {}, extra: Partial<Event> = {}) =>
    act('session.bind', payload, { sessionId: 'target', cardId, ...extra });
  const business = () => { const s = store.getState(); return { projects: s.projects, cards: s.cards, sessions: s.sessions, notifications: s.notifications, preferences: s.preferences }; };
  return { store, user, act, bind, business };
}

it('C-370 AI代办可创建同项目卡片且状态固定未开始、验收未勾选、来源真实', () => {
  const x = fixture();
  const result = x.act('card.create', { title: '代办任务', description: '目标和范围', tags: ['合成'], priority: '高', dueDate: '2026-10-09', acceptance: ['可核验条件'] }, { sessionId: 'issuer' });
  expect(result.ok).toBe(true);
  const card = x.store.getState().cards.find(c => c.id === result.cardId)!;
  expect(card).toMatchObject({ projectId: 'p', title: '代办任务', status: '未开始', priority: '高', members: [] });
  expect(card.acceptance).toEqual([expect.objectContaining({ checked: false, acceptanceState: '未验收', source: assistant })]);
  expect(x.store.getState().activities.at(-1)?.actor).toEqual(assistant);
});

it('C-371 AI代办可绑定同项目其他真实会话，已有主会话保留、新会话为协作', () => {
  const x = fixture(); x.user('session.bind', {}, { sessionId: 'main', cardId: 'a' });
  expect(x.bind('a').ok).toBe(true);
  expect(x.store.getState().cards.find(c => c.id === 'a')?.members.map(m => [m.sessionId, m.role])).toEqual([['main', '主会话'], ['target', '协作会话']]);
  expect(x.bind('b', {}, { sessionId: 'issuer' }).ok).toBe(true);
  expect(x.store.getState().cards.find(c => c.id === 'b')?.members[0]?.role).toBe('主会话');
});

it.each([
  { actor: { kind: 'assistant', id: 'missing' } },
  { actor: { kind: 'assistant' } },
  { projectId: 'q' },
  { projectId: undefined },
  { sessionId: 'target' },
])('C-372 创建必须有同项目可信登记issuer，不能冒用sessionId：%j', extra => {
  const x = fixture(); const before = x.business();
  const result = x.act('card.create', { title: '不应创建' }, extra as Partial<Event>);
  expect(result.ok).toBe(false); expect(result.errors.join()).toMatch(/AI代办|发起会话|同一项目|身份/);
  expect(x.business()).toEqual(before);
});

it.each([{ cardId: 'other' }, { sessionId: 'foreign' }, { sessionId: 'missing' }, { projectId: 'q' }])
  ('C-372 绑定必须核对issuer、target和卡片同项目：%j', extra => {
    const x = fixture(); const before = x.business();
    expect(x.bind('a', {}, extra).ok).toBe(false); expect(x.business()).toEqual(before);
  });

const forbidden: EventType[] = ['project.upsert', 'card.update', 'card.archive', 'card.delete', 'card.complete', 'card.reorder',
  'checklist.add', 'checklist.update', 'checklist.delete', 'checklist.check', 'acceptance.evidence', 'acceptance.reject',
  'blocker.resolve', 'artifact.add', 'artifact.delete', 'session.upsert', 'session.unbind', 'session.create_failed',
  'turn.start', 'turn.end', 'report.submit', 'instruction.apply', 'notification.resolve', 'activity.undo',
  'comment.add', 'preferences.update', 'sync.missing', 'sync.failed', 'sync.recovered', 'store.restore'];
it.each(forbidden)('C-373 assistant硬白名单拒绝%s及嵌套越权', type => {
  const x = fixture(); const before = x.business();
  const result = x.act(type, { id: 'forged', title: 'forged', list: 'acceptance', checked: true, fields: { status: '已完成' },
    action: 'complete', quote: '这个算完成了', operations: [{ type: 'card.complete', payload: {} }] }, { sessionId: 'issuer', cardId: 'a', turnId: 'forged' });
  expect(result.ok).toBe(false); expect(x.business()).toEqual(before);
  if (type !== 'store.restore') expect(result.errors.join()).toContain('AI代办仅允许');
});

it.each(['已归档', '找不到'] as const)('C-374 AI代办拒绝不可用目标会话：%s', status => {
  const x = fixture(); x.user('session.upsert', { id: 'target', projectId: 'p', name: 'target', status });
  const before = x.business(); expect(x.bind('a').ok).toBe(false); expect(x.business()).toEqual(before);
});
it('C-374 AI代办不能绑定归档或删除卡片', () => {
  const x = fixture(); x.user('card.archive', {}, { cardId: 'a' });
  const before = x.business(); expect(x.bind('a').ok).toBe(false); expect(x.business()).toEqual(before);
  x.user('card.delete', {}, { cardId: 'a' }); expect(x.bind('a').ok).toBe(false);
});

it('C-375 换绑必须精确声明当前卡片，confirmed不能替代；确认后只移动成员', () => {
  const x = fixture(); x.user('session.bind', {}, { sessionId: 'target', cardId: 'a' });
  x.user('artifact.add', { title: '原成果', link: '/synthetic/result.md' }, { cardId: 'a' });
  const before = x.business();
  for (const payload of [{}, { confirmed: true }, { expectedCurrentCardId: 'wrong' }]) {
    expect(x.bind('b', payload).ok).toBe(false); expect(x.business()).toEqual(before);
  }
  expect(x.bind('b', { expectedCurrentCardId: 'a' }).ok).toBe(true);
  const state = x.store.getState();
  expect(state.sessions.find(s => s.id === 'target')?.cardId).toBe('b');
  expect(state.cards.find(c => c.id === 'a')?.artifacts).toHaveLength(1);
  expect(state.cards.find(c => c.id === 'b')?.artifacts).toHaveLength(0);
});

it('C-376 运行中换绑本轮仍报告原卡，结束后才切换', () => {
  const x = fixture(); x.user('session.bind', {}, { sessionId: 'target', cardId: 'a' });
  x.user('turn.start', {}, { actor: { kind: 'system' }, sessionId: 'target', turnId: 'real-turn' });
  expect(x.bind('b', { expectedCurrentCardId: 'a' }).ok).toBe(true);
  expect(x.store.getState().sessions.find(s => s.id === 'target')).toMatchObject({ cardId: 'a', pendingCardId: 'b', turn: { cardId: 'a' } });
  expect(x.user('report.submit', { fields: { progressText: '原轮进展' } }, { actor: { kind: 'session', id: 'target' }, sessionId: 'target', turnId: 'real-turn' }).ok).toBe(true);
  expect(x.store.getState().cards.find(c => c.id === 'a')?.progressText).toBe('原轮进展');
  expect(x.store.getState().cards.find(c => c.id === 'b')?.progressText).toBe('');
  x.user('turn.end', {}, { actor: { kind: 'system' }, sessionId: 'target', turnId: 'real-turn' });
  expect(x.store.getState().sessions.find(s => s.id === 'target')?.cardId).toBe('b');
});

it('C-377 创建和绑定相同event.id重送幂等，不重复卡片或成员', () => {
  const x = fixture(); const create = x.act('card.create', { title: '一次请求' }, { id: 'stable-create' });
  expect(create.ok).toBe(true); const first = x.store.getState();
  expect(x.act('card.create', { title: '一次请求' }, { id: 'stable-create' }).status).toBe('duplicate');
  expect(x.store.getState()).toEqual(first);
  expect(x.bind(create.cardId!, {}, { id: 'stable-bind' }).ok).toBe(true); const second = x.store.getState();
  expect(x.bind(create.cardId!, {}, { id: 'stable-bind' }).status).toBe('duplicate');
  expect(x.store.getState()).toEqual(second);
});

it('C-378 已有不同待换绑不允许被AI请求覆盖或隐式取消', () => {
  const x = fixture(); x.user('session.bind', {}, { sessionId: 'target', cardId: 'a' });
  x.user('turn.start', {}, { actor: { kind: 'system' }, sessionId: 'target', turnId: 'real-turn' });
  x.user('session.bind', { confirmed: true }, { sessionId: 'target', cardId: 'b' });
  const before = x.business();
  for (const card of ['c', 'a']) { expect(x.bind(card, { expectedCurrentCardId: 'a' }).ok).toBe(false); expect(x.business()).toEqual(before); }
  expect(x.bind('b', { expectedCurrentCardId: 'a' }).ok).toBe(true);
});

it.each([{ id: 'model-controlled' }, { status: '已完成' }, { operations: [{ type: 'card.complete', payload: {} }] },
  { members: [{ sessionId: 'foreign' }] }, { actor: { kind: 'user' } }])
  ('C-379 创建拒绝未知字段或嵌套操作：%j', extra => {
    const x = fixture(); const before = x.business();
    expect(x.act('card.create', { title: '测试', ...extra }).ok).toBe(false); expect(x.business()).toEqual(before);
  });
it('C-379 首次绑定的多余错误期望和冲突目标不能静默成功', () => {
  const x = fixture(); const before = x.business();
  expect(x.bind('a', { expectedCurrentCardId: 'b' }).ok).toBe(false);
  expect(x.bind('a', { cardId: 'b' }).ok).toBe(false);
  expect(x.bind('a', { cardNo: 2 }).ok).toBe(false);
  expect(x.business()).toEqual(before);
});
