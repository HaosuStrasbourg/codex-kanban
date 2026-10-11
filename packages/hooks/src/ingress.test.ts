import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Event, State } from '../../core/src/types.ts';
import { CurrentPromptStore } from './prompt-store.ts';
import { ingestHook } from './ingress.ts';
import { ProjectStore } from '../../core/src/index.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-hook-ingress-'))); directories.push(directory);
  const state: State = { schemaVersion: 1, revision: 0, updatedAt: null, projects: [{ id: 'P', name: '合成项目', folder: directory, nextNo: 1 }], cards: [], activities: [], notifications: [], preferences: {},
    sessions: [{ id: 'A', projectId: 'P', name: '合成会话', status: '空闲', cardId: 'card', lastActivityAt: '' }],
  };
  const events: Event[] = [];
  const store = { getState: () => state, applyEvent: (event: Event) => { events.push(event); return { ok: true, status: 'applied' as const, errors: [], warnings: [] }; } };
  const prompts = new CurrentPromptStore(directory);
  return { directory, store, prompts, events };
}

test('C-062 Hook 当前原文只进短期交接，不写入业务活动事件或读取transcript', () => {
  const { directory, store, prompts, events } = setup();
  const response = ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'A', turn_id: 'T', cwd: directory,
    prompt: '合成消息：这个算完成了', transcript_path: '/must-not-read/private-transcript' }, { store, prompts });
  expect(response?.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  expect(prompts.get('A', 'T')?.text).toBe('合成消息：这个算完成了');
  expect(events.find(event => event.type === 'turn.start')).toMatchObject({ actor: { kind: 'system' }, sessionId: 'A', turnId: 'T', payload: {} });
  expect(JSON.stringify(events)).not.toContain('合成消息：这个算完成了');
  expect(JSON.stringify(events)).not.toContain('private-transcript');
});

test('C-145 Interrupt 只发中断事件并清除原文；Stop 发正常结束事件', () => {
  const { directory, store, prompts, events } = setup();
  for (const event of ['Interrupt', 'Stop']) {
    prompts.record({ sessionId: 'A', turnId: 'T', text: '合成消息' });
    expect(ingestHook({ hook_event_name: event, session_id: 'A', turn_id: 'T', cwd: directory }, { store, prompts })).toBeUndefined();
    expect(prompts.get('A', 'T')).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', payload: { interrupted: event === 'Interrupt' } });
  }
});

test('C-007 未识别的cwd不猜worktree归属，不登记会话或原文', () => {
  const { directory, store, prompts, events } = setup();
  expect(ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'A', turn_id: 'T', cwd: join(directory, 'unknown'), prompt: '合成消息' }, { store, prompts })).toBeUndefined();
  expect(events).toEqual([]);
  expect(prompts.get('A', 'T')).toBeNull();
});

test('C-142 缺真实session/turn字段时不虚构回合，无法解析输入时不写入', () => {
  const { directory, store, prompts, events } = setup();
  for (const payload of [null, { hook_event_name: 'UserPromptSubmit', session_id: 'A', cwd: directory, prompt: '合成消息' },
    { hook_event_name: 'Stop', turn_id: 'T', cwd: directory }]) {
    expect(ingestHook(payload, { store, prompts })).toBeUndefined();
  }
  expect(events).toEqual([]);
});

test('C-062 子agent载荷不能使用父session_id覆盖当前用户原话', () => {
  const { directory, store, prompts, events } = setup();
  prompts.record({ sessionId: 'A', turnId: 'T', text: '主会话合成消息' });
  const response = ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: 'A', turn_id: 'T', cwd: directory,
    prompt: '子agent合成消息：这个算完成了', agent_id: 'child', agent_type: 'worker' }, { store, prompts });
  expect(response).toBeUndefined(); expect(events).toEqual([]);
  expect(prompts.get('A', 'T')?.text).toBe('主会话合成消息');
});

test('C-062 同turn的steering更新当前原话，Stop后的重复载荷不能复活已结束的授权', () => {
  const { directory, prompts } = setup();
  const store = new ProjectStore(join(directory, 'kanban.sqlite'));
  try {
    expect(store.applyEvent({ id: 'project', type: 'project.upsert', actor: { kind: 'user' }, payload: { id: 'P', name: '合成项目', folder: directory } }).ok).toBe(true);
    const message = { hook_event_name: 'UserPromptSubmit', session_id: 'A', turn_id: 'T', cwd: directory, prompt: '这个算完成了' };
    ingestHook(message, { store, prompts });
    ingestHook({ ...message, prompt: '先不要完成' }, { store, prompts });
    expect(prompts.get('A', 'T')?.text).toBe('先不要完成');
    expect(store.getState().activities.filter(event => event.type === 'turn.start')).toHaveLength(1);
    ingestHook({ ...message, hook_event_name: 'Stop', stop_hook_active: false }, { store, prompts });
    expect(prompts.get('A', 'T')).toBeNull();
    ingestHook(message, { store, prompts });
    expect(prompts.get('A', 'T')).toBeNull();
    expect(store.getState().sessions[0]?.turn).toBeUndefined();
  } finally { store.close(); }
});
