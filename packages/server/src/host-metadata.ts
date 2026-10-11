import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/** Codex 0.154 app-server metadata only; never returns preview, turns, logs or credentials. */
export interface HostProject { id: string; name: string; roots: string[] }
export interface HostProjectCandidate { readonly id: string; readonly name: string }
export interface HostThread {
  id: string; name: string | null; projectId: string | null; canonicalProjectId: string | null; cwd: string;
  createdAt: number; updatedAt: number; recencyAt: number | null;
  status: 'notLoaded' | 'idle' | 'active' | 'systemError';
  assignment: 'canonical' | 'legacy-exact-cwd';
}
export type HostThreadAvailability = { status: 'available'; thread: HostThread } | { status: 'archived'; threadId: string };
export interface HostMetadataProvider {
  list(folder: string, canonicalProjectId?: string): Promise<{ project: HostProject; threads: HostThread[] }>;
  verify(folder: string, threadId: string, canonicalProjectId?: string): Promise<HostThread>;
  projects?(): Promise<HostProject[]>;
  current?(threadId: string): Promise<{ threadId: string; folder: string; hostProjectId: string | null }>;
  availability?(folder: string, threadId: string, canonicalProjectId?: string): Promise<HostThreadAvailability>;
}
type ReadMethod = 'initialize' | 'project/list' | 'thread/list' | 'thread/read';
/** Injection is only for isolated tests. No caller-provided RPC is exposed by the provider. */
export interface HostMetadataChannel {
  request(method: ReadMethod, params: Record<string, unknown>): Promise<unknown>;
  initialized(): Promise<void>;
  close(): Promise<void>;
}
type ErrorCode = 'INVALID_SCOPE' | 'HOST_UNAVAILABLE' | 'HOST_REQUEST_FAILED' | 'UNSUPPORTED' |
  'INVALID_RESPONSE' | 'UNEXPECTED_SERVER_REQUEST' | 'STEP_TIMEOUT' | 'TOTAL_TIMEOUT' |
  'INCOMPLETE' | 'PROJECT_NOT_FOUND' | 'PROJECT_AMBIGUOUS' | 'PROJECT_MAPPING_INVALID' | 'THREAD_NOT_FOUND' | 'CLOSE_FAILED';
export class HostMetadataError extends Error {
  readonly code: ErrorCode;
  readonly projectCandidates?: readonly HostProjectCandidate[];
  constructor(code: ErrorCode, projectCandidates?: readonly HostProjectCandidate[]) {
    // Deliberately omit raw host error messages, stderr and response parameters.
    super(code === 'PROJECT_AMBIGUOUS' ? '这个目录关联了多个 Codex 项目，请选择所属项目' : `Codex 会话元数据读取未完成：${code}`);
    this.name = 'HostMetadataError';
    this.code = code;
    if (code === 'PROJECT_AMBIGUOUS' && projectCandidates) {
      this.projectCandidates = Object.freeze(projectCandidates.map(({ id, name }) => Object.freeze({ id, name })));
    }
  }
}
const STEP_MS = 5_000;
// Reserve one second of the 20-second process budget for graceful/forced cleanup.
const QUERY_MS = 19_000;
const MAX_PAGES = 10;
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
function fail(code: ErrorCode): never { throw new HostMetadataError(code); }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const path = (value: unknown): value is string => identifier(value) && isAbsolute(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function within<T>(promise: Promise<T>, milliseconds: number, code: ErrorCode): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HostMetadataError(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function openStdioChannel(): HostMetadataChannel {
  // Official process uses its own normal auth/config/state. This is NOT a promise
  // of a filesystem-read-only launch; only our outgoing RPC surface is read-only.
  const executable = process.env.CPM_CODEX_BIN ?? 'codex';
  if (process.env.CPM_CODEX_BIN !== undefined && (!isAbsolute(executable) || executable.includes('\0'))) fail('HOST_UNAVAILABLE');
  const child = spawn(executable, ['app-server', '--stdio', '--disable', 'plugins'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: HostMetadataError): void }>();
  let sequence = 0;
  let buffer = '';
  let bytes = 0;
  let terminal: HostMetadataError | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let signalClosed!: () => void;
  const didClose = new Promise<void>(resolve => { signalClosed = resolve; });
  function terminate(error: HostMetadataError) {
    terminal ??= error;
    for (const wait of pending.values()) wait.reject(terminal);
    pending.clear();
  }
  child.on('error', () => terminate(new HostMetadataError('HOST_UNAVAILABLE')));
  child.stdin.on('error', () => terminate(new HostMetadataError('HOST_UNAVAILABLE')));
  child.stdout.on('error', () => terminate(new HostMetadataError('HOST_UNAVAILABLE')));
  child.on('close', () => {
    closed = true;
    buffer = '';
    terminate(new HostMetadataError('HOST_UNAVAILABLE'));
    signalClosed();
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (terminal) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8 * 1024 * 1024 || Buffer.byteLength(buffer) + Buffer.byteLength(chunk) > 4 * 1024 * 1024) {
      terminate(new HostMetadataError('INVALID_RESPONSE')); return;
    }
    buffer += chunk;
    let end: number;
    while (!terminal && (end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message: Record<string, unknown> | undefined;
      try { message = object(JSON.parse(line)); } catch { /* No raw line in errors. */ }
      if (!message) { terminate(new HostMetadataError('INVALID_RESPONSE')); break; }
      if (typeof message.method === 'string') {
        if ('id' in message) terminate(new HostMetadataError('UNEXPECTED_SERVER_REQUEST'));
        // All notifications, including log parameters, are discarded.
        continue;
      }
      const wait = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!wait) { terminate(new HostMetadataError('INVALID_RESPONSE')); break; }
      pending.delete(message.id as number);
      if ('error' in message) {
        const rpcError = object(message.error);
        const error = new HostMetadataError(rpcError?.code === -32601 ? 'UNSUPPORTED' : 'HOST_REQUEST_FAILED');
        wait.reject(error); terminate(error);
      } else if ('result' in message && !('method' in message)) wait.resolve(message.result);
      else { const error = new HostMetadataError('INVALID_RESPONSE'); wait.reject(error); terminate(error); }
    }
  });
  function send(value: Record<string, unknown>) {
    if (terminal) throw terminal;
    if (closing || closed) fail('HOST_UNAVAILABLE');
    try { child.stdin.write(`${JSON.stringify(value)}\n`); }
    catch { terminate(new HostMetadataError('HOST_UNAVAILABLE')); throw terminal; }
  }
  async function waitClosed(milliseconds: number): Promise<boolean> {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([didClose.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), milliseconds);
    })]); } finally { clearTimeout(timer); }
  }
  return {
    request(method, params) {
      if (!['initialize', 'project/list', 'thread/list', 'thread/read'].includes(method)) return Promise.reject(new HostMetadataError('HOST_REQUEST_FAILED'));
      return new Promise((resolve, reject) => {
        const requestId = ++sequence;
        pending.set(requestId, { resolve, reject });
        try { send({ id: requestId, method, params }); }
        catch (error) { pending.delete(requestId); reject(error); }
      });
    },
    async initialized() { send({ method: 'initialized' }); },
    close() {
      closing ??= (async () => {
        const previousFailure = terminal;
        terminate(new HostMetadataError('HOST_UNAVAILABLE'));
        buffer = '';
        child.stdin.end();
        if (!await waitClosed(200)) {
          child.kill('SIGTERM');
          if (!await waitClosed(400)) {
            child.kill('SIGKILL');
            if (!await waitClosed(400)) fail('CLOSE_FAILED');
          }
        }
        if (previousFailure) throw previousFailure;
      })();
      return closing;
    },
  };
}

function readThread(value: unknown, project: HostProject | undefined, folder: string): HostThread | undefined {
  const row = object(value);
  if (!row || !identifier(row.id) || !path(row.cwd) || !(row.projectId === null || identifier(row.projectId))) fail('INVALID_RESPONSE');
  const assignment = project && row.projectId === project.id ? 'canonical'
    : row.projectId === null && row.cwd === folder ? 'legacy-exact-cwd' : undefined;
  if (!assignment) return;
  const status = object(row.status)?.type;
  if (!(row.name === null || typeof row.name === 'string' && row.name.length <= 10_000) ||
    !timestamp(row.createdAt) || !timestamp(row.updatedAt) || !(row.recencyAt === null || timestamp(row.recencyAt)) ||
    !['notLoaded', 'idle', 'active', 'systemError'].includes(String(status))) fail('INVALID_RESPONSE');
  return { id: row.id, name: row.name, projectId: row.projectId, canonicalProjectId: project?.id ?? null, cwd: row.cwd,
    createdAt: row.createdAt, updatedAt: row.updatedAt, recencyAt: row.recencyAt,
    status: status as HostThread['status'], assignment };
}

async function isCurrentUnarchivedRollout(file: string, archived = false): Promise<boolean> {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const root = join(home, archived ? 'archived_sessions' : 'sessions');
  const withinRoot = (parent: string, child: string) => {
    const part = relative(parent, child);
    return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  if (!path(home) || normalize(home) !== home || !path(file) || normalize(file) !== file || !withinRoot(root, file)) return false;
  try {
    // Metadata only: never open the rollout or read its contents. realpath
    // equality also rejects symlinked ancestors and stale/moved rollout paths.
    const [homeStat, rootStat, fileStat] = await Promise.all([lstat(home), lstat(root), lstat(file)]);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !fileStat.isFile() || fileStat.isSymbolicLink()) return false;
    const [realHome, realRoot, realFile] = await Promise.all([realpath(home), realpath(root), realpath(file)]);
    return realHome === home && realRoot === root && realFile === file && withinRoot(realRoot, realFile);
  } catch { return false; }
}

export function createHostMetadataProvider(options: {
  openChannel?: () => HostMetadataChannel;
  /** Only injected by isolated tests; production checks pure filesystem metadata. */
  verifyUnarchivedPath?: (file: string) => Promise<boolean>;
  /** Only injected by isolated tests; production verifies exact archived-file metadata. */
  verifyArchivedPath?: (file: string) => Promise<boolean>;
} = {}): HostMetadataProvider {
  // These discovery reads deliberately do not enumerate conversations. The
  // exact current thread is supplied only by the host's per-request identity.
  async function discover(threadId?: string): Promise<HostProject[] | { threadId: string; folder: string; hostProjectId: string | null }> {
    if (threadId !== undefined && !identifier(threadId)) fail('INVALID_SCOPE');
    const channel = (options.openChannel ?? openStdioChannel)();
    let stopped = false;
    const request = (method: ReadMethod, params: Record<string, unknown>) => {
      if (stopped) fail('TOTAL_TIMEOUT');
      return within(channel.request(method, params), STEP_MS, 'STEP_TIMEOUT');
    };
    try {
      return await within((async () => {
        await request('initialize', { clientInfo: { name: 'codex_pm_metadata', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        await within(channel.initialized(), STEP_MS, 'STEP_TIMEOUT');
        if (threadId !== undefined) {
          const response = object(await request('thread/read', { threadId, includeTurns: false }));
          const row = object(response?.thread);
          if (!row || row.id !== threadId || !path(row.cwd) || normalize(row.cwd) !== row.cwd ||
            !(row.projectId === null || identifier(row.projectId)) || row.archived === true || row.archive === true ||
            row.parentThreadId !== null || typeof row.source !== 'string' || !SOURCE_KINDS.includes(row.source) || !path(row.path)) fail('THREAD_NOT_FOUND');
          const verifyPath = options.verifyUnarchivedPath ?? isCurrentUnarchivedRollout;
          if (!await within(verifyPath(row.path), STEP_MS, 'STEP_TIMEOUT')) fail('THREAD_NOT_FOUND');
          return { threadId, folder: row.cwd, hostProjectId: row.projectId };
        }
        const projects = new Map<string, HostProject>(), cursors = new Set<string>();
        let cursor: string | undefined;
        for (let index = 0; index < MAX_PAGES; index++) {
          const page = object(await request('project/list', { limit: 50, ...(cursor ? { cursor } : {}) }));
          if (!page || !Array.isArray(page.data) || page.data.length > 50 || !(page.nextCursor === null || identifier(page.nextCursor))) fail('INVALID_RESPONSE');
          for (const value of page.data) {
            const row = object(value);
            if (!row || !identifier(row.id) || row.id.length > 240 || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 10_000 || !Array.isArray(row.roots)) fail('INVALID_RESPONSE');
            const roots = row.roots.map(root => object(root)?.path);
            if (!roots.every(value => path(value) && normalize(value) === value)) fail('INVALID_RESPONSE');
            // A cloud-only project has no local directory and is not imported.
            if (!roots.length) continue;
            const project = { id: row.id, name: row.name, roots: [...new Set(roots as string[])] };
            if (projects.has(project.id) && JSON.stringify(projects.get(project.id)) !== JSON.stringify(project)) fail('INVALID_RESPONSE');
            projects.set(project.id, project);
          }
          if (page.nextCursor === null) return [...projects.values()];
          cursor = page.nextCursor;
          if (cursors.has(cursor)) fail('INCOMPLETE');
          cursors.add(cursor);
        }
        return fail('INCOMPLETE');
      })(), QUERY_MS, 'TOTAL_TIMEOUT');
    } catch (error) {
      if (error instanceof HostMetadataError) throw error;
      throw new HostMetadataError('HOST_REQUEST_FAILED');
    } finally {
      stopped = true;
      try { await within(channel.close(), 1_000, 'CLOSE_FAILED'); }
      catch (error) { if (error instanceof HostMetadataError) throw error; throw new HostMetadataError('CLOSE_FAILED'); }
    }
  }
  async function read(folder: string, canonicalProjectId: string | undefined, threadId: string, availability: true): Promise<HostThreadAvailability>;
  async function read(folder: string, canonicalProjectId: string | undefined, threadId: string): Promise<HostThread>;
  async function read(folder: string, canonicalProjectId?: string): Promise<{ project: HostProject; threads: HostThread[] }>;
  async function read(folder: string, canonicalProjectId?: string, threadId?: string, availability = false): Promise<{ project: HostProject; threads: HostThread[] } | HostThread | HostThreadAvailability> {
    if (!path(folder) || canonicalProjectId !== undefined && !identifier(canonicalProjectId)) fail('INVALID_SCOPE');
    let channel: HostMetadataChannel | undefined;
    let stopped = false;
    try {
      channel = (options.openChannel ?? openStdioChannel)();
      const current = channel;
      async function request(method: ReadMethod, params: Record<string, unknown>) {
        if (stopped) fail('TOTAL_TIMEOUT');
        return within(current.request(method, params), STEP_MS, 'STEP_TIMEOUT');
      }
      async function pages(method: 'project/list' | 'thread/list', params: Record<string, unknown>, consume: (row: unknown) => void) {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let index = 0; index < MAX_PAGES; index++) {
          const page = object(await request(method, { ...params, ...(cursor ? { cursor } : {}) }));
          if (!page || !Array.isArray(page.data) || !(page.nextCursor === null || identifier(page.nextCursor))) fail('INVALID_RESPONSE');
          if (page.data.length > Number(params.limit)) fail('INVALID_RESPONSE');
          for (const row of page.data) consume(row);
          if (page.nextCursor === null) return;
          cursor = page.nextCursor;
          if (cursors.has(cursor)) fail('INCOMPLETE');
          cursors.add(cursor);
        }
        fail('INCOMPLETE');
      }
      const work = async (): Promise<HostThread | HostThreadAvailability | { project: HostProject; threads: HostThread[] }> => {
        await request('initialize', { clientInfo: { name: 'codex_pm_metadata', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        await within(current.initialized(), STEP_MS, 'STEP_TIMEOUT');
        const matches = new Map<string, HostProject>();
        await pages('project/list', { limit: 50 }, value => {
          const row = object(value);
          if (!row || !Array.isArray(row.roots)) fail('INVALID_RESPONSE');
          const roots = row.roots.map(root => object(root)?.path);
          if (!roots.includes(folder)) return;
          if (!identifier(row.id) || typeof row.name !== 'string' || row.name.length > 10_000 || !roots.every(path)) fail('INVALID_RESPONSE');
          matches.set(row.id, { id: row.id, name: row.name, roots: roots as string[] });
        });
        if (canonicalProjectId !== undefined && !matches.has(canonicalProjectId)) fail('PROJECT_MAPPING_INVALID');
        if (matches.size === 0) fail('PROJECT_NOT_FOUND');
        const common = { limit: 100, useStateDbOnly: true, sortKey: 'updated_at', sourceKinds: SOURCE_KINDS, modelProviders: [] };
        if (threadId !== undefined) {
          const response = object(await request('thread/read', { threadId, includeTurns: false }));
          const row = object(response?.thread);
          if (!row) fail('THREAD_NOT_FOUND');
          if (row.id !== threadId || !path(row.cwd) || !(row.projectId === null || identifier(row.projectId))) fail('INVALID_RESPONSE');
          if ((!availability && (row.archived === true || row.archive === true)) || row.parentThreadId !== null ||
            typeof row.source !== 'string' || !SOURCE_KINDS.includes(row.source)) fail('THREAD_NOT_FOUND');
          if (canonicalProjectId === undefined && row.cwd !== folder) fail('THREAD_NOT_FOUND');
          const project = row.projectId !== null ? matches.get(row.projectId)
            : canonicalProjectId !== undefined ? matches.get(canonicalProjectId)
              : matches.size === 1 ? [...matches.values()][0] : undefined;
          if (row.projectId !== null && (!project || canonicalProjectId !== undefined && row.projectId !== canonicalProjectId)) fail('THREAD_NOT_FOUND');
          const item = readThread(row, project, folder);
          if (!item || !path(row.path)) fail('THREAD_NOT_FOUND');
          // thread/read includes archived records and can return a stale stored
          // path. Require fresh metadata proving a regular file under sessions.
          const verifyPath = options.verifyUnarchivedPath ?? isCurrentUnarchivedRollout;
          if (availability) {
            if (row.archived === true || row.archive === true) return { status: 'archived', threadId };
            if (await within(verifyPath(row.path), STEP_MS, 'STEP_TIMEOUT')) return { status: 'available', thread: item };
            const verifyArchivedPath = options.verifyArchivedPath ?? (file => isCurrentUnarchivedRollout(file, true));
            if (await within(verifyArchivedPath(row.path), STEP_MS, 'STEP_TIMEOUT')) return { status: 'archived', threadId };
            // Older host records can keep a stale unarchived path after archive.
            // Only a positive, exact-ID archived record is evidence. An empty
            // list or any read error never establishes that a thread was deleted.
            let confirmed = false;
            await pages('thread/list', { ...common, archived: true, cwd: row.cwd }, value => {
              const archived = object(value);
              if (archived?.id !== threadId) return;
              if (archived.projectId !== row.projectId || archived.cwd !== row.cwd || archived.parentThreadId !== null || typeof archived.source !== 'string' || !SOURCE_KINDS.includes(archived.source)) fail('INVALID_RESPONSE');
              if (!readThread(archived, project, folder)) fail('INVALID_RESPONSE');
              confirmed = true;
            });
            if (confirmed) return { status: 'archived', threadId };
            fail('THREAD_NOT_FOUND');
          }
          if (!await within(verifyPath(row.path), STEP_MS, 'STEP_TIMEOUT')) fail('THREAD_NOT_FOUND');
          return item;
        }
        if (canonicalProjectId === undefined && matches.size !== 1) {
          throw new HostMetadataError('PROJECT_AMBIGUOUS', [...matches.values()].map(({ id, name }) => ({ id, name })));
        }
        const project = canonicalProjectId === undefined ? [...matches.values()][0]! : matches.get(canonicalProjectId)!;
        const threads = new Map<string, HostThread>();
        const identities = new Map<string, string>();
        const consume = (value: unknown) => {
          const item = readThread(value, project, folder);
          // Track filtered rows too: an accepted row cannot replace a conflicting identity.
          const row = object(value)!;
          const key = row.id as string, assignment = JSON.stringify([row.projectId, row.cwd]);
          const previous = identities.get(key);
          if (previous !== undefined && previous !== assignment) fail('INVALID_RESPONSE');
          identities.set(key, assignment);
          if (item) threads.set(item.id, item);
        };
        await pages('thread/list', { ...common, projectId: project.id }, consume);
        // Legacy Desktop threads can have null projectId. Only exact known root
        // cwd is accepted; unrelated project IDs and unknown worktrees stay out.
        await pages('thread/list', { ...common, cwd: folder }, consume);
        return { project, threads: [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)) };
      };
      return await within(work(), QUERY_MS, 'TOTAL_TIMEOUT');
    } catch (error) {
      if (error instanceof HostMetadataError) throw error;
      throw new HostMetadataError('HOST_REQUEST_FAILED');
    } finally {
      stopped = true;
      if (channel) {
        try { await within(channel.close(), 1_000, 'CLOSE_FAILED'); }
        catch (error) {
          if (error instanceof HostMetadataError) throw error;
          throw new HostMetadataError('CLOSE_FAILED');
        }
      }
    }
  }
  return {
    async projects() { return await discover() as HostProject[]; },
    async current(threadId) { return await discover(threadId) as { threadId: string; folder: string; hostProjectId: string | null }; },
    async availability(folder, threadId, canonicalProjectId) {
      if (!identifier(threadId)) fail('INVALID_SCOPE');
      return read(folder, canonicalProjectId, threadId, true);
    },
    list: read,
    async verify(folder, threadId, canonicalProjectId) {
      if (!identifier(threadId)) fail('INVALID_SCOPE');
      return read(folder, canonicalProjectId, threadId);
    },
  };
}
