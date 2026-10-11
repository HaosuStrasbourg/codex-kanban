import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from './index.ts';
import type { Actor, Card, Event, EventType } from './types.ts';

const stores: core.ProjectStore[] = [], dirs: string[] = [];
const user: Actor = { kind: 'user', id: 'me' }, system: Actor = { kind: 'system' };
let seq = 0;
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture(file = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-planning-')); dirs.push(dir);
  const path = file ? join(dir, 'test.sqlite') : ':memory:';
  const store = new core.ProjectStore(path); stores.push(store);
  const event = (type: EventType, payload: Record<string, unknown> = {}, opts: Partial<Event> = {}) => store.applyEvent({ id: `planning-${++seq}`, type, actor: user, payload, ...opts });
  event('project.upsert', { id: 'p', name: 'Project', folder: '/synthetic' });
  const cardId = event('card.create', { title: 'Plan', acceptance: ['用户验收'] }, { projectId: 'p' }).cardId!;
  for (const id of ['a', 'b']) { event('session.upsert', { id, name: id, projectId: 'p' }, { actor: system }); event('session.bind', {}, { sessionId: id, cardId }); }
  const card = () => store.getState().cards.find(c => c.id === cardId)!;
  const update = (fields: Record<string, unknown>) => event('card.update', { fields }, { cardId });
  const start = (id = 'a') => event('turn.start', {}, { actor: system, sessionId: id, turnId: `turn-${++seq}` });
  const report = (fields: Record<string, unknown>, reasons?: Record<string, string>, id = 'a') => event('report.submit', { fields, reasons }, { actor: { kind: 'session', id }, sessionId: id, turnId: store.getState().sessions.find(s => s.id === id)?.turn?.id });
  return { dir, path, store, event, cardId, card, update, start, report };
}

describe('规划与跟进核心规则', () => {
  it('C-410 新卡默认本人且人工和AI代办可明确创建跟进字段', () => {
    const x = fixture(); expect(x.card()).toMatchObject({ followUpOwner: '我', followUpAt: null });
    const result = x.event('card.create', { title: 'AI plan', followUpOwner: '同事', followUpAt: '2026-10-06T19:30+08:00' }, { projectId: 'p', actor: { kind: 'assistant', id: 'a' } });
    expect(result.ok).toBe(true); expect(x.store.getState().cards.find(c => c.id === result.cardId)).toMatchObject({ status: '未开始', followUpOwner: '同事', followUpAt: '2026-10-06T19:30+08:00' });
    expect(x.update({ followUpOwner: '', followUpAt: null }).ok).toBe(true);
    expect(x.card()).toMatchObject({ followUpOwner: '', followUpAt: null });
  });
  it('C-411 计划中属于自然前进且允许直接开始执行', () => {
    const x = fixture(); x.start();
    for (const status of ['计划中', '进行中', '待验收']) { expect(x.report({ status }).status).toBe('applied'); expect(x.card().status).toBe(status); }
    x.update({ status: '未开始' }); x.start(); expect(x.report({ status: '进行中' }).status).toBe('applied'); expect(x.card().status).toBe('进行中');
  });
  it('C-412 计划中仍保留阻断卡点与AI完成验收限制', () => {
    const x = fixture(); expect(x.update({ status: '计划中' }).ok).toBe(true); x.start();
    x.event('checklist.add', { list: 'blockers', content: '等待材料', blocking: true }, { cardId: x.cardId });
    expect(x.report({ status: '进行中' }).ok).toBe(true); expect(x.card().flags).toContain('阻塞');
    expect(x.report({ status: '已完成' }).warnings).toContain('需先解除卡点'); expect(x.card().status).toBe('进行中');
    x.event('blocker.resolve', { itemId: x.card().blockers[0]!.id, basis: '材料已到' }, { cardId: x.cardId });
    x.report({ status: '已完成' }); expect(x.card().status).toBe('待验收'); expect(x.card().acceptance[0]!.checked).toBe(false);
  });
  it('C-413 AI跟进字段更新各自须原因且不影响合法进展', () => {
    const x = fixture(); x.start();
    const ignored = x.report({ followUpOwner: '协作者', followUpAt: '2026-10-06T09:30:00+08:00', progressText: '已调研' });
    expect(ignored.warnings).toEqual(expect.arrayContaining(['followUpOwner 已忽略：未写原因', 'followUpAt 已忽略：未写原因']));
    expect(x.card()).toMatchObject({ followUpOwner: '我', followUpAt: null, progressText: '已调研' });
    expect(x.report({ followUpOwner: '协作者', followUpAt: '2026-10-06T09:30:00+08:00' }, { followUpOwner: '已明确分工', followUpAt: '已约定时间' }).status).toBe('applied');
    expect(x.card()).toMatchObject({ followUpOwner: '协作者', followUpAt: '2026-10-06T09:30:00+08:00' });
  });
  it('C-414 跟进字段保留人工修改并记录其他会话同字段冲突', () => {
    const x = fixture(); x.start('a'); x.start('b');
    x.update({ followUpOwner: '我手动指定' });
    expect(x.report({ followUpOwner: 'AI猜测' }, { followUpOwner: '建议' }).warnings).toContain('followUpOwner 已忽略：以用户修改为准');
    x.report({ followUpAt: '2026-10-06T10:00Z' }, { followUpAt: '约定' });
    expect(x.report({ followUpAt: '2026-10-07T10:00Z' }, { followUpAt: '另一约定' }, 'b').warnings).toContain('followUpAt 有冲突，保留当前值');
    expect(x.card()).toMatchObject({ followUpOwner: '我手动指定', followUpAt: '2026-10-06T10:00Z' }); expect(x.card().conflicts[0]!.field).toBe('followUpAt');
  });
  it('C-415 跟进字段及计划状态可撤销且活动重放一致', () => {
    const x = fixture(); const before = x.card(); const result = x.update({ status: '计划中', followUpOwner: '同事', followUpAt: '2026-10-06T18:00+08:00' });
    expect(x.card()).toMatchObject({ status: '计划中', followUpOwner: '同事', followUpAt: '2026-10-06T18:00+08:00' });
    expect(x.event('activity.undo', { activityId: result.activityId }).ok).toBe(true);
    expect(x.card()).toMatchObject({ status: before.status, followUpOwner: before.followUpOwner, followUpAt: before.followUpAt });
    expect(core.ProjectStore.replay(x.store.getState().activities)).toEqual(x.store.getState());
  });
  it.each(['2026-10-06', '2026-10-06T18:00', '2026-02-30T18:00Z', '2025-02-29T18:00Z', '2026-10-06T24:00Z', '2026-10-06T18:61Z', '2026-10-06T18:00:60Z', '2026-10-06T18:00+24:00', '2026-10-06T18:00+08:60', 'not a date', '', 42])('C-416 非真实或不含时区的跟进时间整次拒绝 %s', value => {
    const x = fixture(); const before = x.card();
    expect(x.update({ followUpAt: value, title: '不该生效' }).ok).toBe(false); expect(x.card()).toEqual(before);
  });
  it.each(['2024-02-29T12:30Z', '2026-10-06T18:00:00.123+08:00', '2026-10-06T10:00:00Z', '2026-10-06T10:00:00-04:00', null])('C-416 有效闰日及带时区ISO跟进时间接受 %s', value => {
    const x = fixture(); expect(x.update({ followUpAt: value }).ok).toBe(true); expect(x.card().followUpAt).toBe(value);
  });
  it('C-417 今日跟进以北京时间日期含以前和今日稍后并保留暂停', () => {
    const x = fixture(), now = '2026-10-05T16:30:00Z';
    expect(core.businessDate(now)).toBe('2026-10-06'); expect(core.businessDate(new Date('2026-10-05T15:59:59Z'))).toBe('2026-10-05');
    for (const followUpAt of ['2026-10-04T01:00Z', '2026-10-06T23:59:00+08:00']) {
      x.update({ followUpAt, status: '暂停' }); expect(core.matchesFollowUpView(x.card(), '今天需跟进', now)).toBe(true);
      expect(x.store.query({ view: '今天需跟进', now }).cards.map(c => c.id)).toEqual([x.cardId]);
    }
    x.update({ followUpAt: '2026-10-06T16:00:00Z' }); expect(core.matchesFollowUpView(x.card(), '今天需跟进', now)).toBe(false);
    x.update({ followUpAt: null }); expect(x.store.query({ view: '今天需跟进', now }).cards).toEqual([]);
    for (const patch of [{ status: '已完成' }, { archived: true }, { deleted: true }]) expect(core.matchesFollowUpView({ ...x.card(), followUpAt: now, ...patch } as Card, '今天需跟进', now)).toBe(false);
  });
  it('C-418 逾期只含北京今天以前计划交付日且排除完成归档删除', () => {
    const x = fixture(), now = '2026-10-05T16:00:00Z';
    for (const dueDate of ['2026-10-04', '2026-10-05']) { x.update({ dueDate, status: '暂停' }); expect(x.store.query({ view: '逾期事项', now }).cards.map(c => c.id)).toEqual([x.cardId]); }
    for (const dueDate of ['2026-10-06', '2026-10-07', null]) { x.update({ dueDate }); expect(x.store.query({ view: '逾期事项', now }).cards).toEqual([]); }
    for (const patch of [{ status: '已完成' }, { archived: true }, { deleted: true }]) expect(core.matchesFollowUpView({ ...x.card(), dueDate: '2026-10-05', ...patch } as Card, '逾期事项', now)).toBe(false);
  });
  it('C-418 跟进时间排序比较真实时刻且跟进人可精确筛选', () => {
    const x = fixture(); x.update({ followUpAt: '2026-10-06T09:00+08:00', followUpOwner: '我' });
    const other = x.event('card.create', { title: 'Earlier', followUpOwner: '同事', followUpAt: '2026-10-06T02:00+02:00' }, { projectId: 'p' }).cardId!;
    const later = x.event('card.create', { title: 'Later', followUpOwner: '我', followUpAt: '2026-10-06T02:00Z' }, { projectId: 'p' }).cardId!;
    expect(x.store.query({ sort: { field: 'followUpAt', direction: 'asc' } }).cards.map(c => c.id)).toEqual([other, x.cardId, later]);
    expect(x.store.query({ filters: [{ field: 'followUpOwner', condition: 'eq', value: '同事' }] }).cards.map(c => c.id)).toEqual([other]);
  });
  it('C-419 旧SQLite复开只读补空字段且保留活动修订绑定及备份恢复', () => {
    const x = fixture(true); x.start(); x.report({ progressText: '旧进展' }); x.store.close();
    const db = new DatabaseSync(x.path);
    const snapshot = JSON.parse((db.prepare('SELECT json FROM snapshot WHERE id=1').get() as { json: string }).json);
    for (const card of snapshot.cards) { delete card.followUpOwner; delete card.followUpAt; }
    db.prepare('UPDATE snapshot SET json=? WHERE id=1').run(JSON.stringify(snapshot));
    for (const row of db.prepare('SELECT seq,json FROM activities').all() as { seq: number; json: string }[]) {
      const activity = JSON.parse(row.json);
      for (const change of activity.changes) if (change.collection === 'cards' && !change.field && change.after) { delete change.after.followUpOwner; delete change.after.followUpAt; }
      db.prepare('UPDATE activities SET json=? WHERE seq=?').run(JSON.stringify(activity), row.seq);
    }
    const raw = db.prepare('SELECT json FROM snapshot').all(), activities = db.prepare('SELECT * FROM activities').all(); db.close();
    const reopened = new core.ProjectStore(x.path); stores.push(reopened); const state = reopened.getState();
    expect(state.cards[0]).toMatchObject({ followUpOwner: '', followUpAt: null, progressText: '旧进展', status: snapshot.cards[0].status, members: snapshot.cards[0].members, fieldRevisions: snapshot.cards[0].fieldRevisions });
    expect(state.revision).toBe(snapshot.revision); expect(state.sessions).toEqual(snapshot.sessions); expect(core.ProjectStore.replay(state.activities)).toEqual(state);
    const inspector = new DatabaseSync(x.path); expect(inspector.prepare('SELECT json FROM snapshot').all()).toEqual(raw); expect(inspector.prepare('SELECT * FROM activities').all()).toEqual(activities); inspector.close();
    const backup = join(x.dir, 'old-backup.sqlite'); reopened.backup(backup); reopened.restore(backup); expect(reopened.getState()).toEqual(state);
    const edit = reopened.applyEvent({ id: 'old-edit', type: 'card.update', actor: user, cardId: x.cardId, payload: { fields: { followUpAt: '2026-10-07T10:00Z' } } }); expect(edit.ok).toBe(true);
    expect(core.ProjectStore.replay(reopened.getState().activities)).toEqual(reopened.getState());
    const updatedBackup = join(x.dir, 'updated-backup.sqlite'); const updated = reopened.getState(); reopened.backup(updatedBackup); reopened.restore(updatedBackup); expect(reopened.getState()).toEqual(updated);
  });
  const dateRoutes = ['人工修改', '会话报告', '人工创建', 'AI代办创建'] as const;
  function submitDueDate(x: ReturnType<typeof fixture>, route: typeof dateRoutes[number], dueDate: string | null) {
    if (route === '人工修改') return x.update({ dueDate, title: '计划变更' });
    if (route === '会话报告') return x.report({ dueDate, progressText: '计划变更' }, { dueDate: '按明确约定更新' });
    return x.event('card.create', { title: '新计划', dueDate }, { projectId: 'p', actor: route === 'AI代办创建' ? { kind: 'assistant', id: 'a' } : user });
  }
  it.each(dateRoutes.flatMap(route => ['2026-02-30', '2025-02-29', '2026-04-31'].map(date => ({ route, date }))))('C-446 $route 拒绝不存在的计划交付日 $date 且卡片保持不变', ({ route, date }) => {
    const x = fixture(); x.start(); const before = x.store.getState();
    const result = submitDueDate(x, route, date);
    expect(result.ok).toBe(false); expect(result.status).toBe('rejected');
    const after = x.store.getState();
    expect(after.cards).toEqual(before.cards); expect(after.projects).toEqual(before.projects); expect(after.sessions).toEqual(before.sessions);
  });
  it.each(dateRoutes.flatMap(route => ['2024-02-29', '2000-02-29', null].map(date => ({ route, date }))))('C-446 $route 接受真实闰日和清空 $date', ({ route, date }) => {
    const x = fixture(); x.update({ dueDate: '2026-10-06' }); x.start();
    const result = submitDueDate(x, route, date);
    expect(result.ok).toBe(true); expect(result.status).toBe('applied');
    expect(x.store.getState().cards.find(card => card.id === result.cardId)!.dueDate).toBe(date);
  });
});
