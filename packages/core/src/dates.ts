import type { Card } from './types.ts';

/** Strict local calendar date/time plus an explicit ISO timezone. No overflowing dates. */
export function isValidFollowUpAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59 || Number(match[6] ?? 0) > 23 || Number(match[7] ?? 0) > 59) return false;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1] && Number.isFinite(Date.parse(value));
}

const businessCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export function businessDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('业务日期无效');
  const parts = businessCalendar.formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

export type FollowUpView = '今天需跟进' | '逾期事项';
export function matchesFollowUpView(card: Pick<Card, 'status' | 'archived' | 'deleted' | 'followUpAt' | 'dueDate'>, view: FollowUpView, now: string | Date = new Date()): boolean {
  if (card.status === '已完成' || card.archived || card.deleted) return false;
  const today = businessDate(now);
  if (view === '今天需跟进') return isValidFollowUpAt(card.followUpAt) && businessDate(card.followUpAt) <= today;
  return card.dueDate !== null && card.dueDate < today;
}
