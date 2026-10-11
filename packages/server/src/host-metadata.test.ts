import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { createHostMetadataProvider, HostMetadataError, type HostMetadataChannel } from './host-metadata.ts';

const launch = vi.hoisted(() => vi.fn());
const fileMetadata = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: launch }));
vi.mock('node:fs/promises', () => fileMetadata);
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); launch.mockReset(); fileMetadata.lstat.mockReset(); fileMetadata.realpath.mockReset(); });

test('C-062 元数据模块可由正式Node类型剥离模式直接导入', async () => {
  const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const moduleUrl = new URL('./host-metadata.ts', import.meta.url).href;
  const script = `const module = await import(${JSON.stringify(moduleUrl)}); const error = new module.HostMetadataError('INVALID_SCOPE'); if (error.code !== 'INVALID_SCOPE' || typeof module.createHostMetadataProvider !== 'function') process.exit(1);`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { timeout: 5_000, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

const folder = '/synthetic/project';
const rolloutPath = '/synthetic/codex-home/sessions/2026/10/06/rollout-synthetic.jsonl';
const project = { id: 'canonical-project', name: '合成项目', roots: [{ path: folder }], metadata: { private: 'discard' } };
const thread = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `合成-${id}`, projectId: project.id,
  cwd: folder, createdAt: 123, updatedAt: 456, recencyAt: null, status: { type: 'idle', private: 'discard' },
  source: 'appServer', parentThreadId: null,
  preview: 'PRIVATE PREVIEW', turns: ['PRIVATE TURN'], path: rolloutPath, gitInfo: { private: 'discard' }, ...extra });
function setup(respond: (method: string, params: Record<string, unknown>) => unknown = (method, params) =>
  method === 'project/list' ? { data: [project], nextCursor: null } : method === 'thread/list'
    ? { data: params.projectId ? [thread('a')] : [thread('b', { projectId: null })], nextCursor: null }
    : method === 'thread/read' ? { thread: params.threadId === 'a' ? thread('a') : params.threadId === 'b' ? thread('b', { projectId: null }) : null } : {}) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const channel: HostMetadataChannel = {
    request: vi.fn(async (method, params) => { requests.push({ method, params }); return respond(method, params); }),
    initialized: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const verifyUnarchivedPath = vi.fn(async () => true);
  return { provider: createHostMetadataProvider({ openChannel: () => channel, verifyUnarchivedPath }), channel, requests, verifyUnarchivedPath };
}

test('C-650 官方项目分页只提取名称和绝对目录，不枚举会话或保留额外数据', async () => {
  const { provider, requests, channel } = setup((method, params) => method === 'project/list' ? {
    data: params.cursor ? [{ ...project, id: 'Q', name: '项目Q', roots: [{ path: '/synthetic/Q' }] }] : [project, { id: 'cloud', name: '云项目', roots: [] }],
    nextCursor: params.cursor ? null : 'next',
  } : {});
  expect(await provider.projects!()).toEqual([{ id: project.id, name: project.name, roots: [folder] }, { id: 'Q', name: '项目Q', roots: ['/synthetic/Q'] }]);
  expect(requests.map(item => item.method)).toEqual(['initialize', 'project/list', 'project/list']);
  expect(channel.close).toHaveBeenCalledOnce();
});

test('C-650 官方项目来源不完整或同ID不同目录时整体拒绝，不交出半份来源', async () => {
  for (const respond of [
    (method: string) => method === 'project/list' ? { data: [project], nextCursor: 'repeat' } : {},
    (method: string) => method === 'project/list' ? { data: [project, { ...project, roots: [{ path: '/synthetic/different' }] }], nextCursor: null } : {},
    (method: string) => method === 'project/list' ? { data: [{ ...project, roots: [{ path: '../relative' }] }], nextCursor: null } : {},
  ]) {
    const { provider, channel } = setup(respond);
    await expect(provider.projects!()).rejects.toBeInstanceOf(HostMetadataError);
    expect(channel.close).toHaveBeenCalledOnce();
  }
});

test('C-651 项目列表不可用也能独立核验宿主指定当前会话精确目录，正文不返回', async () => {
  const { provider, requests, verifyUnarchivedPath } = setup(method => {
    if (method === 'project/list') throw new HostMetadataError('UNSUPPORTED');
    return method === 'thread/read' ? { thread: thread('current', { projectId: null }) } : {};
  });
  expect(await provider.current!('current')).toEqual({ threadId: 'current', folder, hostProjectId: null });
  expect(requests.map(item => item.method)).toEqual(['initialize', 'thread/read']);
  expect(requests[1]?.params).toEqual({ threadId: 'current', includeTurns: false });
  expect(verifyUnarchivedPath).toHaveBeenCalledWith(rolloutPath);
});

test('C-651 当前身份不符、子代理、归档、非绝对目录与过期路径均不能登记', async () => {
  for (const extra of [{ id: 'other' }, { parentThreadId: 'parent' }, { archived: true }, { cwd: 'relative' }, { cwd: `${folder}/../other` }]) {
    const { provider } = setup(method => method === 'thread/read' ? { thread: thread('current', extra) } : {});
    await expect(provider.current!('current')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
  }
  const { provider, verifyUnarchivedPath } = setup(method => method === 'thread/read' ? { thread: thread('current') } : {});
  verifyUnarchivedPath.mockResolvedValue(false);
  await expect(provider.current!('current')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
});

test('C-131 官方精确归档列表同ID正证据可补旧path，空列表或不同身份不能判归档删除', async () => {
  for (const kind of ['confirmed', 'empty', 'wrong-project', 'subagent'] as const) {
    const { provider, requests, verifyUnarchivedPath } = setup((method, params) => method === 'project/list' ? { data: [project], nextCursor: null }
      : method === 'thread/read' ? { thread: thread('target') }
        : method === 'thread/list' && params.archived === true ? { data: kind === 'empty' ? [] : [thread('target', kind === 'wrong-project' ? { projectId: 'other' } : kind === 'subagent' ? { parentThreadId: 'parent' } : {})], nextCursor: null } : {});
    verifyUnarchivedPath.mockResolvedValue(false);
    if (kind === 'confirmed') expect(await provider.availability!(folder, 'target', project.id)).toEqual({ status: 'archived', threadId: 'target' });
    else await expect(provider.availability!(folder, 'target', project.id)).rejects.toBeInstanceOf(HostMetadataError);
    expect(requests.find(item => item.method === 'thread/read')?.params).toEqual({ threadId: 'target', includeTurns: false });
    expect(requests.find(item => item.method === 'thread/list')?.params).toMatchObject({ archived: true, cwd: folder, useStateDbOnly: true });
  }
});

test('C-131 真实归档路径验证拒绝穿越和符号链接，只读文件元数据', async () => {
  vi.stubEnv('CODEX_HOME', '/synthetic/codex-home');
  for (const variant of ['valid', 'symlink', 'traversal'] as const) {
    const file = variant === 'traversal' ? '/synthetic/codex-home/archived_sessions/../sessions/thread.jsonl' : '/synthetic/codex-home/archived_sessions/thread.jsonl';
    fileMetadata.lstat.mockImplementation(async (value: string) => ({ isDirectory: () => value !== file, isFile: () => value === file, isSymbolicLink: () => variant === 'symlink' && value === file }));
    fileMetadata.realpath.mockImplementation(async (value: string) => value);
    const channel: HostMetadataChannel = { request: async (method, params) => method === 'project/list' ? { data: [project], nextCursor: null }
      : method === 'thread/read' ? { thread: thread('target', { path: file }) } : method === 'thread/list' && params.archived ? { data: [], nextCursor: null } : {}, initialized: async () => {}, close: async () => {} };
    const provider = createHostMetadataProvider({ openChannel: () => channel });
    if (variant === 'valid') expect(await provider.availability!(folder, 'target', project.id)).toEqual({ status: 'archived', threadId: 'target' });
    else await expect(provider.availability!(folder, 'target', project.id)).rejects.toBeInstanceOf(HostMetadataError);
  }
});

test('C-123 metadata合并canonical与精确cwd legacy，丢弃内容字段与其他项目', async () => {
  const { provider, channel, requests } = setup((method, params) => method === 'project/list'
    ? { data: [project], nextCursor: null } : method === 'thread/list' ? { data: params.projectId
      ? [thread('a', { cwd: '/synthetic/worktree' })]
      : [thread('a', { cwd: '/synthetic/worktree' }), thread('b', { projectId: null }), thread('foreign', { projectId: 'other' }), thread('unknown-worktree', { projectId: null, cwd: '/synthetic/worktree' })], nextCursor: null } : {});
  const result = await provider.list(folder);
  expect(result.project).toEqual({ id: project.id, name: project.name, roots: [folder] });
  expect(result.threads.map(item => [item.id, item.assignment])).toEqual([['a', 'canonical'], ['b', 'legacy-exact-cwd']]);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|discard|preview|turns|gitInfo/);
  expect(result.threads[0]).toEqual({ id: 'a', name: '合成-a', projectId: project.id, canonicalProjectId: project.id,
    cwd: '/synthetic/worktree', createdAt: 123, updatedAt: 456, recencyAt: null, status: 'idle', assignment: 'canonical' });
  expect(requests.filter(item => item.method === 'thread/list').every(item => item.params.useStateDbOnly === true)).toBe(true);
  expect(channel.close).toHaveBeenCalledOnce();
});

test('C-319 每次历史会话分页明确查询所有modelProviders，继续排除subagent来源', async () => {
  const {provider,requests} = setup((method,params) => method === 'project/list' ? {data:[project],nextCursor:null}
    : method === 'thread/list' ? {data:[thread(params.cursor ? 'page-two' : 'page-one')],nextCursor:params.cursor ? null : 'next-page'} : {});
  await provider.list(folder);
  const queries = requests.filter(item=>item.method==='thread/list');
  expect(queries).toHaveLength(4);
  for (const {params} of queries) {
    expect(params.modelProviders).toEqual([]);
    expect(params.sourceKinds).toEqual(['cli','vscode','exec','appServer','unknown']);
    expect(params.useStateDbOnly).toBe(true);
  }
});

test('C-005 verify只返回真实同项目元数据，拒绝不存在与另一项目ID', async () => {
  expect((await setup().provider.verify(folder, 'b')).assignment).toBe('legacy-exact-cwd');
  await expect(setup().provider.verify(folder, 'missing')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
  const { provider } = setup((method) => method === 'project/list' ? { data: [project], nextCursor: null }
    : method === 'thread/read' ? { thread: thread('foreign', { projectId: 'another-project' }) } : {});
  await expect(provider.verify(folder, 'foreign')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
});

test('C-001 项目必须按完整根目录唯一匹配，不能用名称或目录前缀推断', async () => {
  for (const data of [[{ ...project, roots: [{ path: `${folder}-other` }] }], [project, { ...project, id: 'duplicate' }]]) {
    const { provider, channel } = setup(method => method === 'project/list' ? { data, nextCursor: null } : {});
    await expect(provider.list(folder)).rejects.toBeInstanceOf(HostMetadataError);
    expect(channel.close).toHaveBeenCalledOnce();
  }
});

test('C-001 多候选只返回匹配目录的ID和名称，选择前不读任何会话', async () => {
  const other = { ...project, id: 'second', name: '合成第二项目', roots: [{ path: '/synthetic/other' }, { path: folder }] };
  const unrelated = { ...project, id: 'unrelated', name: '无关项目不得返回', roots: [{ path: '/synthetic/unrelated' }] };
  const { provider, requests, channel } = setup(method => method === 'project/list' ? { data: [project, other, unrelated], nextCursor: null } : {});
  const error = await provider.list(folder).catch(value => value);
  expect(error).toBeInstanceOf(HostMetadataError);
  expect(error.code).toBe('PROJECT_AMBIGUOUS');
  expect(error.message).toBe('这个目录关联了多个 Codex 项目，请选择所属项目');
  expect(error.projectCandidates).toEqual([{ id: project.id, name: project.name }, { id: other.id, name: other.name }]);
  expect(JSON.stringify(error.projectCandidates)).not.toMatch(/roots|metadata|unrelated|discard/);
  expect(requests.some(item => item.method === 'thread/list')).toBe(false);
  expect(channel.close).toHaveBeenCalledOnce();
});

test('C-005 用户指定映射仍须匹配目录，只枚举选定canonical及精确cwd legacy', async () => {
  const other = { ...project, id: 'second', name: '合成第二项目', roots: [{ path: '/synthetic/other' }, { path: folder }] };
  const { provider, requests } = setup((method, params) => method === 'project/list' ? { data: [project, other], nextCursor: null }
    : method === 'thread/list' ? { data: params.projectId ? [thread('selected', { projectId: other.id })] : [thread('legacy', { projectId: null }), thread('wrong')], nextCursor: null }
      : method === 'thread/read' ? { thread: thread('legacy', { projectId: null }) } : {});
  const result = await provider.list(folder, other.id);
  expect(result.project.id).toBe(other.id);
  expect(result.threads.map(item => item.id)).toEqual(['legacy', 'selected']);
  expect(result.threads.every(item => item.canonicalProjectId === other.id)).toBe(true);
  expect(requests.filter(item => item.method === 'thread/list').map(item => item.params.projectId)).toEqual([other.id, undefined]);
  expect((await provider.verify(folder, 'legacy', other.id)).canonicalProjectId).toBe(other.id);
});

test('C-005 映射不存在或已移出目录时拒绝，不回退到其他canonical', async () => {
  const unrelated = { ...project, id: 'unrelated', roots: [{ path: '/synthetic/unrelated' }] };
  for (const selected of ['missing', unrelated.id]) {
    const { provider, requests } = setup(method => method === 'project/list' ? { data: [project, unrelated], nextCursor: null } : {});
    await expect(provider.list(folder, selected)).rejects.toMatchObject({ code: 'PROJECT_MAPPING_INVALID' });
    expect(requests.some(item => item.method === 'thread/list')).toBe(false);
  }
});

test('C-123 完整空结果与不支持错误分开，错误不泄露宿主消息', async () => {
  const empty = setup(method => method === 'project/list' ? { data: [project], nextCursor: null }
    : method === 'thread/list' ? { data: [], nextCursor: null } : {});
  expect((await empty.provider.list(folder)).threads).toEqual([]);
  const failed = setup(() => { throw new Error('PRIVATE unexpected server failure'); });
  await expect(failed.provider.list(folder)).rejects.toMatchObject({ code: 'HOST_REQUEST_FAILED' });
  expect(failed.channel.close).toHaveBeenCalledOnce();
});

test('C-123 分页走完才交结果，重复游标与超过界限明确失败', async () => {
  const paged = setup((method, params) => method === 'project/list'
    ? { data: params.cursor ? [project] : [], nextCursor: params.cursor ? null : 'page2' }
    : method === 'thread/list' ? { data: [thread(params.projectId ? 'a' : 'b', { projectId: params.projectId ?? null })], nextCursor: null } : {});
  expect((await paged.provider.list(folder)).threads).toHaveLength(2);
  const repeated = setup(method => method === 'project/list' ? { data: [], nextCursor: 'same' } : {});
  await expect(repeated.provider.list(folder)).rejects.toMatchObject({ code: 'INCOMPLETE' });
  let page = 0;
  const endless = setup(method => method === 'project/list' ? { data: [], nextCursor: String(++page) } : {});
  await expect(endless.provider.list(folder)).rejects.toMatchObject({ code: 'INCOMPLETE' });
});

test('C-123 缺少projectId或损坏的同项目元数据不能被当作legacy', async () => {
  const missing = thread('bad'); delete (missing as Record<string, unknown>).projectId;
  for (const bad of [missing, thread('bad', { createdAt: '123' })]) {
    const { provider } = setup(method => method === 'project/list' ? { data: [project], nextCursor: null }
      : method === 'thread/list' ? { data: [bad], nextCursor: null } : {});
    await expect(provider.list(folder)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  }
});

test('C-129 单步超时后finally关闭，不等待未完成请求', async () => {
  vi.useFakeTimers();
  const { provider, channel } = setup(() => new Promise(() => {}));
  const result = expect(provider.list(folder)).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(5001);
  await result;
  expect(channel.close).toHaveBeenCalledOnce();
});

test('C-129 持续有响应仍受20秒整体截止约束', async () => {
  vi.useFakeTimers();
  let page = 0;
  const { provider, channel } = setup(async method => {
    await new Promise(resolve => setTimeout(resolve, 4000));
    return method === 'project/list' ? { data: [], nextCursor: String(++page) } : {};
  });
  const result = expect(provider.list(folder)).rejects.toMatchObject({ code: 'TOTAL_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(20001);
  await result;
  expect(channel.close).toHaveBeenCalledOnce();
});

function syntheticProcess(respond: (message: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null as number | null, signalCode: null });
  child.stdin.on('data', chunk => {
    const message = JSON.parse(String(chunk)) as Record<string, unknown>;
    const response = respond(message);
    if (response) queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
  });
  child.stdin.on('finish', () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0, null)); });
  launch.mockReturnValue(child);
  return child;
}

test('C-123 真实provider固定stdio命令和只读RPC，不公开任意RPC', async () => {
  const methods: unknown[] = [];
  const child = syntheticProcess(message => {
    methods.push(message.method);
    if (!('id' in message)) return;
    const result = message.method === 'project/list' ? { data: [project], nextCursor: null }
      : message.method === 'thread/list' ? { data: [], nextCursor: null } : {};
    return { id: message.id, result };
  });
  expect((await createHostMetadataProvider().list(folder)).threads).toEqual([]);
  expect(launch.mock.calls[0]?.slice(0, 2)).toEqual(['codex', ['app-server', '--stdio', '--disable', 'plugins']]);
  expect(methods).toEqual(['initialize', 'initialized', 'project/list', 'thread/list', 'thread/list']);
  expect(child.exitCode).toBe(0);
  expect(child.kill).not.toHaveBeenCalled();
});

test('C-129 宿主意外请求立即失败关闭，拒绝RPC错误且不输出其内容', async () => {
  for (const message of [{ id: 99, method: 'item/commandExecution/requestApproval', params: { secret: 'PRIVATE' } },
    { id: 1, error: { code: -32601, message: 'PRIVATE unsupported method' } }]) {
    const child = syntheticProcess(() => message);
    await expect(createHostMetadataProvider().list(folder)).rejects.toMatchObject({ code: 'method' in message ? 'UNEXPECTED_SERVER_REQUEST' : 'UNSUPPORTED' });
    expect(child.exitCode).toBe(0);
  }
});

test('C-129 清理不退出的子进程会SIGTERM并等到close', async () => {
  vi.useFakeTimers();
  const child = syntheticProcess(() => ({ id: 99, method: 'unexpected/request' }));
  child.stdin.removeAllListeners('finish');
  child.kill.mockImplementation(() => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0, 'SIGTERM')); return true; });
  const result = expect(createHostMetadataProvider().list(folder)).rejects.toMatchObject({ code: 'UNEXPECTED_SERVER_REQUEST' });
  await vi.advanceTimersByTimeAsync(201);
  await result;
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(child.exitCode).toBe(0);
});

test('C-129 finally清理失败也只返回受控错误，不泄露底层错误', async () => {
  const { provider, channel } = setup();
  vi.mocked(channel.close).mockRejectedValue(new Error('PRIVATE cleanup failure'));
  await expect(provider.list(folder)).rejects.toMatchObject({ code: 'CLOSE_FAILED' });
});

const overlappingProject = { ...project, id: 'overlapping', name: '合成重叠项目', roots: [{ path: '/synthetic/other' }, { path: folder }] };

test('C-399 verify精确legacy会话不被目录重叠阻塞，也不冒认canonical项目', async () => {
  const { provider, requests, channel } = setup(method => method === 'project/list'
    ? { data: [project, overlappingProject], nextCursor: null } : method === 'thread/read'
      ? { thread: thread('target', { projectId: null }) } : {});
  const actual = await provider.verify(folder, 'target');
  expect(actual).toMatchObject({ id: 'target', projectId: null, canonicalProjectId: null, cwd: folder, assignment: 'legacy-exact-cwd' });
  expect(JSON.stringify(actual)).not.toMatch(/PRIVATE|discard|preview|turns|gitInfo|source|parentThreadId/);
  expect(requests.filter(item => item.method === 'thread/read')).toEqual([{ method: 'thread/read', params: { threadId: 'target', includeTurns: false } }]);
  expect(requests.some(item => item.method === 'thread/list')).toBe(false);
  expect(channel.close).toHaveBeenCalledOnce();
  await expect(provider.list(folder)).rejects.toMatchObject({ code: 'PROJECT_AMBIGUOUS' });
});

test('C-400 verify由精确会话的真实canonical归属核验，拒绝其他项目与显式映射冲突', async () => {
  for (const projectId of [project.id, overlappingProject.id, 'foreign']) {
    const { provider } = setup(method => method === 'project/list'
      ? { data: [project, overlappingProject], nextCursor: null } : method === 'thread/read'
        ? { thread: thread('target', { projectId }) } : {});
    if (projectId === 'foreign') {
      await expect(provider.verify(folder, 'target')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    } else {
      expect((await provider.verify(folder, 'target')).canonicalProjectId).toBe(projectId);
      const conflicting = projectId === project.id ? overlappingProject.id : project.id;
      await expect(provider.verify(folder, 'target', conflicting)).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    }
  }
});

test('C-401 verify保留显式映射约束，未确认映射绝不回填其他候选', async () => {
  const { provider, requests } = setup(method => method === 'project/list'
    ? { data: [project, overlappingProject], nextCursor: null } : method === 'thread/read'
      ? { thread: thread('target', { projectId: null }) } : {});
  expect((await provider.verify(folder, 'target', overlappingProject.id)).canonicalProjectId).toBe(overlappingProject.id);
  requests.length = 0;
  await expect(provider.verify(folder, 'target', 'unregistered')).rejects.toMatchObject({ code: 'PROJECT_MAPPING_INVALID' });
  expect(requests.some(item => item.method === 'thread/read')).toBe(false);
  expect((await setup().provider.verify(folder, 'b')).canonicalProjectId).toBe(project.id);
});

test('C-402 verify响应防御拒绝子代理、归档与错cwd', async () => {
  for (const extra of [
    { source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } },
    { source: 'subAgent' }, { parentThreadId: 'parent' }, { archived: true }, { archive: true },
    { projectId: null, cwd: '/synthetic/other' }, { cwd: '/synthetic/unknown-worktree' },
  ]) {
    const { provider, channel, requests } = setup(method => method === 'project/list'
      ? { data: [project], nextCursor: null } : method === 'thread/read'
        ? { thread: thread('target', extra) } : {});
    await expect(provider.verify(folder, 'target')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    expect(channel.close).toHaveBeenCalledOnce();
    expect(requests.some(item => item.method === 'thread/list')).toBe(false);
  }
});

test('C-403 verify仅在显式canonical已核验时接受该项目worktree', async () => {
  const { provider, requests } = setup(method => method === 'project/list'
    ? { data: [project, overlappingProject], nextCursor: null } : method === 'thread/read'
      ? { thread: thread('worktree', { cwd: '/synthetic/worktree' }) } : {});
  await expect(provider.verify(folder, 'worktree')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
  requests.length = 0;
  expect(await provider.verify(folder, 'worktree', project.id)).toMatchObject({ id: 'worktree', canonicalProjectId: project.id, assignment: 'canonical' });
  expect(requests.filter(item => item.method === 'thread/read')).toHaveLength(1);
  expect(requests.some(item => item.method === 'thread/list')).toBe(false);
});

test('C-406 exact read返回不同会话必须失败，不进行list fallback', async () => {
  const { provider, requests, channel, verifyUnarchivedPath } = setup(method => method === 'project/list'
    ? { data: [project, overlappingProject], nextCursor: null } : method === 'thread/read'
      ? { thread: thread('different') } : {});
  await expect(provider.verify(folder, 'target')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(requests.some(item => item.method === 'thread/list')).toBe(false);
  expect(verifyUnarchivedPath).not.toHaveBeenCalled();
  expect(channel.close).toHaveBeenCalledOnce();
});

test('C-406 exact read缺失、不支持或超时均关闭且不返回部分身份，不进行list fallback', async () => {
  const empty = setup(method => method === 'project/list' ? { data: [project, overlappingProject], nextCursor: null }
    : method === 'thread/read' ? { thread: null } : {});
  await expect(empty.provider.verify(folder, 'missing')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
  expect(empty.channel.close).toHaveBeenCalledOnce();
  const unsupported = setup(method => {
    if (method === 'thread/read') throw new HostMetadataError('UNSUPPORTED');
    return method === 'project/list' ? { data: [project, overlappingProject], nextCursor: null } : {};
  });
  await expect(unsupported.provider.verify(folder, 'target')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(unsupported.channel.close).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  const stalled = setup(method => method === 'project/list' ? { data: [project, overlappingProject], nextCursor: null }
    : method === 'thread/read' ? new Promise(() => {}) : {});
  const outcome = expect(stalled.provider.verify(folder, 'target')).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(5001);
  await outcome;
  expect(stalled.channel.close).toHaveBeenCalledOnce();
  for (const attempt of [empty, unsupported, stalled]) expect(attempt.requests.some(item => item.method === 'thread/list')).toBe(false);
});

test('C-406 exact read必须通过纯文件元数据校验，路径不进入白名单结果', async () => {
  const { provider, verifyUnarchivedPath } = setup(method => method === 'project/list' ? { data: [project, overlappingProject], nextCursor: null }
    : method === 'thread/read' ? { thread: thread('target', { projectId: null }) } : {});
  expect(await provider.verify(folder, 'target')).toMatchObject({ id: 'target', canonicalProjectId: null });
  expect(verifyUnarchivedPath).toHaveBeenCalledWith(rolloutPath);
  expect(JSON.stringify(await provider.verify(folder, 'target'))).not.toContain(rolloutPath);
  verifyUnarchivedPath.mockResolvedValue(false);
  await expect(provider.verify(folder, 'target')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
});

test('C-406 实际路径检查仅用lstat和realpath，拒绝归档、缺失、跳目录与符号链接', async () => {
  vi.stubEnv('CODEX_HOME', '/synthetic/codex-home');
  for (const variant of ['valid', 'archived', 'empty', 'missing', 'traversal', 'outside', 'symlink', 'parent-symlink', 'directory']) {
    const file = variant === 'archived' ? '/synthetic/codex-home/archived_sessions/rollout.jsonl'
      : variant === 'empty' ? null : variant === 'traversal' ? '/synthetic/codex-home/sessions/../rollout.jsonl'
        : variant === 'outside' ? '/synthetic/codex-home/sessions-other/rollout.jsonl' : rolloutPath;
    fileMetadata.lstat.mockImplementation(async (value: string) => {
      if (variant === 'missing' && value === file) throw Error('PRIVATE PATH ENOENT');
      return { isFile: () => value === file && variant !== 'directory', isSymbolicLink: () => value === file && variant === 'symlink', isDirectory: () => value !== file || variant === 'directory' };
    });
    fileMetadata.realpath.mockImplementation(async (value: string) => variant === 'parent-symlink' && value === file ? '/synthetic/elsewhere/rollout.jsonl' : value);
    const { channel } = setup(method => method === 'project/list' ? { data: [project, overlappingProject], nextCursor: null }
      : method === 'thread/read' ? { thread: thread('target', { projectId: null, path: file }) } : {});
    const provider = createHostMetadataProvider({ openChannel: () => channel });
    if (variant === 'valid') expect((await provider.verify(folder, 'target')).id).toBe('target');
    else await expect(provider.verify(folder, 'target')).rejects.toMatchObject({ code: 'THREAD_NOT_FOUND' });
    expect(channel.close).toHaveBeenCalledOnce();
  }
});
