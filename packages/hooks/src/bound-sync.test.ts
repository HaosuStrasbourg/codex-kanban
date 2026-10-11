import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from '../../core/src/index.ts';
import type { Event } from '../../core/src/types.ts';
import * as scopeModule from './scope.ts';

// Candidate cases C-330 onward: isolated synthetic processes, not host acceptance.
const directories: string[] = [];
const stores: ProjectStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cpm-bound-sync-'))); directories.push(directory);
  const cwd = join(directory, 'project'); mkdirSync(cwd, { mode: 0o700 });
  const dataDir = join(directory, 'private-data'); mkdirSync(dataDir, { mode: 0o700 });
  const scopePath = join(dataDir, 'hook-scope.json');
  const save = (scope: unknown = { mode: 'bound-sessions', projectIds: ['P'] }) => writeFileSync(scopePath, JSON.stringify(scope), { mode: 0o600 });
  let number = 0;
  const store = new ProjectStore(join(dataDir, 'kanban.sqlite')); stores.push(store);
  const apply = (type: Event['type'], payload: Record<string, unknown>, rest: Partial<Event> = {}) => {
    const result = store.applyEvent({ id: `synthetic-${++number}`, type, actor: { kind: 'user' }, projectId: 'P', payload, ...rest });
    expect(result.ok, result.errors.join(';')).toBe(true); return result;
  };
  apply('project.upsert', { id: 'P', name: '合成项目', folder: cwd });
  const cardId = apply('card.create', { title: '合成卡片', description: '已有任务范围', acceptance: ['合成验收项'] }).cardId!;
  apply('session.upsert', { id: 'A', projectId: 'P', name: '合成会话' });
  apply('session.bind', {}, { sessionId: 'A', cardId });
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'A', turn_id: 'T1', cwd,
    prompt: 'SYNTHETIC_PRIVATE_PROMPT_MUST_NOT_PERSIST', transcript_path: '/must-not-read/transcript', model: 'synthetic' };
  const run = (patch: Record<string, unknown> = {}) => spawnSync(process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url))], {
      input: JSON.stringify({ ...input, ...patch }), encoding: 'utf8', timeout: 5_000,
      env: { PATH: process.env.PATH ?? '', CPM_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1' },
    });
  const quiet = (patch: Record<string, unknown> = {}) => {
    const before = store.getState(); const result = run(patch);
    expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
    expect(store.getState()).toEqual(before); expect(existsSync(join(dataDir, 'current-prompts'))).toBe(false);
  };
  return { directory, cwd, dataDir, scopePath, save, store, apply, cardId, input, run, quiet };
}

test('C-330 项目白名单scope可只读查询，未配置保持关闭', () => {
  const x = setup();
  expect(scopeModule.readBoundSyncScope(x.dataDir)).toBeUndefined();
  x.save();
  expect(scopeModule.readBoundSyncScope(x.dataDir)).toEqual({ mode: 'bound-sessions', projectIds: ['P'] });
  expect(scopeModule.readHookScope(x.dataDir, x.input)).toEqual({ mode: 'bound-sessions', projectIds: ['P'] });
});

test.each([
  { mode: 'bound-sessions', projectIds: [] }, { mode: 'bound-sessions', projectIds: ['*'] },
  { mode: 'bound-sessions', projectIds: ['P', 'P'] }, { mode: 'bound-sessions', projectIds: 'all' },
  { mode: 'bound-sessions', projectIds: [1] }, { mode: 'bound-sessions', projectIds: [' P'] },
  { mode: 'bound-sessions', projectIds: ['P'], enabled: true }, { mode: 'bound-sessions' },
])('C-330 项目范围必须为明确非空唯一ID白名单：%j', scope => {
  const x = setup(); x.save(scope);
  expect(scopeModule.readBoundSyncScope(x.dataDir)).toBeUndefined(); x.quiet();
});

test.each(['scope-link', 'world-readable', 'data-link'])('C-330 项目白名单拒绝不私有或路径别名：%s', reason => {
  const x = setup(); x.save();
  let path = x.dataDir;
  if (reason === 'world-readable') chmodSync(x.scopePath, 0o644);
  if (reason === 'scope-link') { const other = join(x.directory, 'scope'); writeFileSync(other, readFileSync(x.scopePath), { mode: 0o600 }); rmSync(x.scopePath); symlinkSync(other, x.scopePath); }
  if (reason === 'data-link') { path = join(x.directory, 'alias'); symlinkSync(x.dataDir, path); }
  expect(scopeModule.readBoundSyncScope(path)).toBeUndefined();
});

test('C-331 已绑定白名单会话开启真实载荷回合并逐轮报告，不存原文或读取聊天', () => {
  const x = setup(); x.save();
  for (const turnId of ['T1', 'T2']) {
    const result = x.run({ turn_id: turnId });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    const reply = JSON.parse(result.stdout);
    expect(reply.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(x.store.getState().sessions[0]?.turn?.id).toBe(turnId);
    x.apply('report.submit', { noChange: true }, { actor: { kind: 'session', id: 'A' }, sessionId: 'A', cardId: x.cardId, turnId });
    expect(x.run({ turn_id: turnId, hook_event_name: 'Stop' }).stdout).toBe('');
    expect(x.store.getState().sessions[0]?.turn).toBeUndefined();
  }
  expect(existsSync(join(x.dataDir, 'current-prompts'))).toBe(false);
  expect(JSON.stringify(x.store.getState())).not.toContain(x.input.prompt);
  for (const name of readdirSync(x.dataDir)) expect(readFileSync(join(x.dataDir, name)).includes(Buffer.from(x.input.prompt))).toBe(false);
});

test('C-332 首次报告PreToolUse补真实回合，只接受本插件canonical名称并幂等', () => {
  const x = setup(); x.save();
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'mcp__codex_pm__cpm_report', tool_use_id: 'call-1',
    tool_input: { sessionId: 'EVIL', turnId: 'invented', projectId: 'other' } };
  const result = x.run(payload);
  expect(result.status).toBe(0); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(x.store.getState().sessions[0]?.turn?.id).toBe('T1');
  x.run({ ...payload, tool_use_id: 'call-2' });
  x.run();
  expect(x.store.getState().activities.filter(item => item.type === 'turn.start')).toHaveLength(1);
  expect(existsSync(join(x.dataDir, 'current-prompts'))).toBe(false);
});

test.each(['cpm_report', 'mcp__other__cpm_report', 'mcp__codex-pm__cpm_report', 'mcp__codex_pm__cpm_report_more',
  'mcp__codex_pm__cpm_snapshot', 'prefix_mcp__codex_pm__cpm_report'])('C-332 其它工具名不能创建回合：%s', tool_name => {
  const x = setup(); x.save(); x.quiet({ hook_event_name: 'PreToolUse', tool_name, tool_use_id: 'call' });
});

test.each([{ turn_id: undefined }, { turn_id: '' }, { tool_use_id: undefined }])('C-333 不从工具参数或随机ID伪造缺失宿主回合：%j', missing => {
  const x = setup(); x.save(); x.quiet({ hook_event_name: 'PreToolUse', tool_name: 'mcp__codex_pm__cpm_report', tool_use_id: 'call',
    tool_input: { turn_id: 'fake-turn', session_id: 'A' }, ...missing });
});

test.each(['unbound', 'unknown-session', 'outside-project', 'wrong-cwd', 'cwd-alias', 'cross-project', 'agent-id', 'agent-type', 'deleted-card'])(
  'C-334 解绑或范围外Hook立即退出且不写业务数据：%s', reason => {
    const x = setup(); x.save(); const patch: Record<string, unknown> = {};
    if (reason === 'unbound') x.apply('session.unbind', {}, { sessionId: 'A' });
    if (reason === 'unknown-session') patch.session_id = 'unknown';
    if (reason === 'outside-project') x.save({ mode: 'bound-sessions', projectIds: ['Q'] });
    if (reason === 'wrong-cwd') patch.cwd = x.directory;
    if (reason === 'cwd-alias') { const alias = join(x.directory, 'cwd-alias'); symlinkSync(x.cwd, alias); patch.cwd = alias; }
    if (reason === 'cross-project') { x.apply('project.upsert', { id: 'Q', name: '另一个项目', folder: x.directory }); patch.cwd = x.directory; }
    if (reason === 'agent-id') patch.agent_id = 'child';
    if (reason === 'agent-type') patch.agent_type = 'worker';
    if (reason === 'deleted-card') { x.apply('card.archive', { archived: true }, { cardId: x.cardId }); x.apply('card.delete', {}, { cardId: x.cardId }); }
    x.quiet(patch);
  },
);

test('C-335 Stop/Interrupt关闭回合，晚到事件与已结束回合的PreToolUse不可复活或破坏新回合', () => {
  const x = setup(); x.save();
  x.run(); x.run({ hook_event_name: 'Stop' });
  x.quiet({ hook_event_name: 'PreToolUse', tool_name: 'mcp__codex_pm__cpm_report', tool_use_id: 'late' });
  x.run({ turn_id: 'T2' });
  x.quiet({ hook_event_name: 'Interrupt' });
  expect(x.store.getState().sessions[0]?.turn?.id).toBe('T2');
  x.run({ turn_id: 'T2', hook_event_name: 'Interrupt' });
  expect(x.store.getState().sessions[0]?.turn).toBeUndefined();
  expect(x.store.getState().activities.at(-1)?.summary).toContain('第 2 轮被中断');
});

test('C-336 初次与后续同步上下文基于已有事实、不启动工作、不读完整聊天，验收留给用户', () => {
  const x = setup(); x.save();
  const result = x.run(); const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  expect(context).toContain('当前可用上下文'); expect(context).toContain('实际状态');
  expect(context).toContain('不要主动开工'); expect(context).toContain('不要扫描完整聊天'); expect(context).toContain('noChange');
  expect(context).toContain('完成和验收仍由用户'); expect(context).not.toContain('调用 cpm_instruction');
  expect(context).not.toContain(x.input.prompt); expect(context).not.toContain(x.input.transcript_path);
});

test('C-337 SessionStart只补已绑定卡上下文，不创建回合；用户解绑后停止同步', () => {
  const x = setup(); x.save(); const before = x.store.getState();
  const result = x.run({ hook_event_name: 'SessionStart', turn_id: undefined });
  expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
  expect(x.store.getState()).toEqual(before);
  x.run(); x.apply('session.unbind', {}, { sessionId: 'A' });
  x.quiet({ hook_event_name: 'Stop' }); x.quiet({ turn_id: 'T2' });
});
