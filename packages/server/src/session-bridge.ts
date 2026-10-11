import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, opendirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** This module is not a tool surface. Adapters must take issuer/thread IDs only from authenticated host metadata. */
export interface SessionRequestInput { requestId: string; issuerThreadId: string; projectId: string; hostProjectId?: string; cardId: string; name?: string; origin?: 'assistant' }
export interface SessionRequest extends SessionRequestInput { issuedAt: number; expiresAt: number }
export type SessionRequestStatus = 'pending' | 'claiming' | 'claimed' | 'expired' | 'abandoned';
export interface PreparedSessionRequest extends SessionRequest { nonce: string; status: SessionRequestStatus }
export interface SessionRequestView { requestId: string; status: SessionRequestStatus; targetId?: string; issuedAt: number; expiresAt: number }
export interface PendingSessionRequestView extends SessionRequestView { projectId: string; cardId: string; name?: string; status: 'pending' | 'claiming' | 'expired' }
export interface VerifiedSessionThread { id: string; projectId: string; createdAt: number; name?: string }
export interface ClaimSessionRequest { requestId: string; nonce: string; threadId: string }
export interface SessionClaimResult { requestId: string; status: 'claimed'; targetId: string; duplicate: boolean }
export type VerifySessionThread = (threadId: string, request: Readonly<SessionRequest>) => VerifiedSessionThread | Promise<VerifiedSessionThread>;
export interface SessionBridgeOptions {
  clock?: () => number;
  onClaim: (context: { request: Readonly<SessionRequest>; thread: Readonly<VerifiedSessionThread>; eventKey: string }) => void | Promise<void>;
}
export class SessionBridgeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'SessionBridgeError'; this.code = code; }
}
const TTL_MS = 300_000;
type StoredRequest = { version: 1; request: SessionRequest; nonce: string; phase: 'pending' | 'claiming' | 'claimed' | 'abandoned'; targetId?: string; claimedAt?: number };

/**
 * prepare is used only by the App and the explicitly authorized, identity-checked AI create-session tool.
 * abandon remains App-only. Model tools never expose raw prepare or caller-selected issuer/origin.
 * abandon requires the user's explicit confirmation that no new session was created; expiry proves only lack of claim.
 * claim.threadId and prepare.issuerThreadId must be injected from the host's overwritten _meta.threadId.
 * verify must read official metadata, with createdAt converted to epoch milliseconds.
 * onClaim must use eventKey-derived core event IDs so interrupted/failed callback retries are safe,
 * and must throw if either core event fails; returning normally confirms the complete binding.
 * A crash leaves the request lock in place: this module never guesses that a lock is stale or steals it.
 */
export class SessionBridge {
  private directory: string;
  private options: SessionBridgeOptions;
  constructor(dataDir: string, options: SessionBridgeOptions) {
    if (typeof options?.onClaim !== 'function') throw new SessionBridgeError('invalid_input', '缺少受控会话绑定回调');
    const root = resolve(nonEmpty(dataDir, '数据目录', 4096));
    privateDirectory(root);
    this.directory = join(root, 'session-requests'); privateDirectory(this.directory);
    this.options = options;
  }
  async prepare(input: SessionRequestInput): Promise<PreparedSessionRequest> {
    const normalized = requestInput(input);
    return this.locked(normalized.requestId, () => {
      const existing = this.read(normalized.requestId);
      if (existing) {
        if (JSON.stringify(requestInput(existing.request, true)) !== JSON.stringify(normalized)) throw new SessionBridgeError('request_conflict', '同一请求编号的参数已不同，请使用新的请求编号');
        return { ...existing.request, nonce: existing.nonce, status: this.phase(existing) };
      }
      const issuedAt = this.now();
      const record: StoredRequest = { version: 1, request: { ...normalized, issuedAt, expiresAt: issuedAt + TTL_MS }, nonce: randomBytes(32).toString('base64url'), phase: 'pending' };
      this.write(record);
      return { ...record.request, nonce: record.nonce, status: 'pending' };
    });
  }
  async status(requestId: string, issuerThreadId: string): Promise<SessionRequestView> {
    nonEmpty(requestId, '请求编号'); nonEmpty(issuerThreadId, '宿主会话身份');
    const record = this.require(requestId);
    if (record.request.issuerThreadId !== issuerThreadId) throw new SessionBridgeError('forbidden', '此请求不属于当前宿主会话');
    return { requestId, status: this.phase(record), ...(record.targetId ? { targetId: record.targetId } : {}), issuedAt: record.request.issuedAt, expiresAt: record.request.expiresAt };
  }
  claimReportBinding(reportId:string,threadId:string):{projectId:string;cardId:string;sessionId:string}|undefined {
    const key=/^initial-claim:([a-f0-9]{64})$/.exec(reportId)?.[1];
    if(!key)throw new SessionBridgeError('invalid_input','首次报告编号无效，无法核验原授权。');
    const record=this.readRecord(join(this.directory,`${key}.json`));
    if(!record||record.phase!=='claimed'||record.targetId!==threadId)return undefined;
    return {projectId:record.request.projectId,cardId:record.request.cardId,sessionId:record.targetId};
  }
  async abandon(requestId: string, issuerThreadId: string): Promise<SessionRequestView> {
    nonEmpty(requestId, '请求编号'); nonEmpty(issuerThreadId, '宿主会话身份');
    return this.locked(requestId, () => {
      const record = this.require(requestId);
      if (record.request.issuerThreadId !== issuerThreadId) throw new SessionBridgeError('forbidden', '此请求不属于当前宿主会话');
      if (record.phase === 'claiming' || record.phase === 'claimed') throw new SessionBridgeError('invalid_state', '此请求已进入会话绑定，不能放弃，请恢复已有绑定');
      if (record.phase === 'pending') { record.phase = 'abandoned'; this.write(record); }
      return { requestId, status: 'abandoned', issuedAt: record.request.issuedAt, expiresAt: record.request.expiresAt };
    });
  }
  async list(issuerThreadId: string): Promise<PendingSessionRequestView[]> {
    nonEmpty(issuerThreadId, '宿主会话身份'); privateDirectory(this.directory);
    const paths: string[] = [];
    try {
      const directory = opendirSync(this.directory);
      try {
        let count = 0;
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++count > 1000) throw new SessionBridgeError('scan_limit', '创建请求目录超过1000个条目，无法安全列出，请先处理已有记录');
          if (/^[a-f0-9]{64}\.json$/.test(entry.name)) {
            if (!entry.isFile()) throw new SessionBridgeError('storage_error', '创建请求条目不是普通文件');
            paths.push(join(this.directory, entry.name));
          } else if (/^[a-f0-9]{64}\.lock$/.test(entry.name) && entry.isDirectory()) {
            // An active/stale lock is not a ticket and is never reclaimed by a read operation.
          } else if (/^[a-f0-9]{64}\.json\.[a-f0-9]{24}\.tmp$/.test(entry.name) && entry.isFile()) {
            // Atomic writes are visible only after their final rename.
          } else throw new SessionBridgeError('storage_error', '创建请求目录包含无法识别的条目');
        }
      } finally { directory.closeSync(); }
    } catch (error) { if (error instanceof SessionBridgeError) throw error; throw new SessionBridgeError('storage_error', '无法安全扫描创建请求目录'); }
    const currentTime = this.now(), result: PendingSessionRequestView[] = [];
    for (const path of paths) {
      const record = this.readRecord(path);
      if (!record) throw new SessionBridgeError('storage_error', '扫描到的创建请求在读取前消失，请重试');
      if (record.request.issuerThreadId !== issuerThreadId || record.phase === 'claimed' || record.phase === 'abandoned') continue;
      const { requestId, projectId, cardId, name, issuedAt, expiresAt } = record.request;
      result.push({ requestId, projectId, cardId, ...(name !== undefined ? { name } : {}), status: record.phase === 'pending' && expiresAt <= currentTime ? 'expired' : record.phase,
        ...(record.targetId ? { targetId: record.targetId } : {}), issuedAt, expiresAt });
    }
    return result.sort((a, b) => a.issuedAt - b.issuedAt || a.requestId.localeCompare(b.requestId));
  }
  async claim(input: ClaimSessionRequest, verify: VerifySessionThread): Promise<SessionClaimResult> {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['requestId', 'nonce', 'threadId'].includes(key))) throw new SessionBridgeError('invalid_input', '认领参数不符合协议');
    const requestId = nonEmpty(input.requestId, '请求编号'), threadId = nonEmpty(input.threadId, '宿主会话身份');
    const nonce = nonEmpty(input.nonce, '认领票据', 256);
    if (typeof verify !== 'function') throw new SessionBridgeError('verification_failed', '缺少官方会话元数据核验');
    return this.locked(requestId, async () => {
      const record = this.require(requestId);
      const received = createHash('sha256').update(nonce).digest(), expected = createHash('sha256').update(record.nonce).digest();
      if (!timingSafeEqual(received, expected)) throw new SessionBridgeError('forbidden', '认领票据无效');
      if (record.phase === 'abandoned') throw new SessionBridgeError('abandoned', '此请求已由申请者明确放弃，不能再认领');
      if (threadId === record.request.issuerThreadId) throw new SessionBridgeError('verification_failed', '申请会话不能认领新会话票据');
      if (record.targetId && record.targetId !== threadId) throw new SessionBridgeError('target_conflict', '此请求已经固定到其他目标会话');
      if (record.phase === 'claimed') return { requestId, status: 'claimed', targetId: threadId, duplicate: true };
      if (record.phase === 'pending' && this.now() >= record.request.expiresAt) throw new SessionBridgeError('expired', '认领票据已过期，请先在看板核查新会话是否已经创建');
      const publicRequest = Object.freeze({ ...record.request });
      let thread: VerifiedSessionThread;
      try {
        const metadata = await verify(threadId, publicRequest);
        if (!metadata || metadata.id !== threadId || metadata.projectId !== record.request.projectId ||
            typeof metadata.createdAt !== 'number' || !Number.isFinite(metadata.createdAt) ||
            metadata.createdAt < record.request.issuedAt - 2000 || metadata.createdAt > this.now() + 2000) {
          throw new Error('metadata mismatch');
        }
        thread = { id: metadata.id, projectId: metadata.projectId, createdAt: metadata.createdAt,
          ...(typeof metadata.name === 'string' ? { name: metadata.name } : {}) };
      } catch { throw new SessionBridgeError('verification_failed', '官方会话身份、项目或创建时间核验失败'); }
      // Verification may take time. A new claim must still be inside its original TTL when committed.
      if (record.phase === 'pending' && this.now() >= record.request.expiresAt) throw new SessionBridgeError('expired', '认领票据已过期，请先在看板核查新会话是否已经创建');
      record.phase = 'claiming'; record.targetId = threadId; this.write(record);
      try { await this.options.onClaim({ request: publicRequest, thread: Object.freeze(thread), eventKey: `session-request:${requestId}` }); }
      catch(error) { if(error instanceof SessionBridgeError&&error.code==='claim_target_unavailable')throw error; throw new SessionBridgeError('claim_failed', '会话绑定未完成，请由同一目标会话重试'); }
      record.phase = 'claimed'; record.claimedAt = this.now(); this.write(record);
      return { requestId, status: 'claimed', targetId: threadId, duplicate: false };
    });
  }
  private now(): number {
    const value = this.options.clock?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - TTL_MS) throw new SessionBridgeError('invalid_clock', '当前时间无效');
    return value;
  }
  private phase(record: StoredRequest): SessionRequestStatus { return record.phase === 'pending' && this.now() >= record.request.expiresAt ? 'expired' : record.phase; }
  private filename(requestId: string): string { return join(this.directory, `${createHash('sha256').update(requestId).digest('hex')}.json`); }
  private async locked<T>(requestId: string, action: () => T | Promise<T>): Promise<T> {
    privateDirectory(this.directory);
    const path = join(this.directory, `${createHash('sha256').update(requestId).digest('hex')}.lock`);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') throw new SessionBridgeError('busy', '此请求正在处理，请稍后重试；已有锁不会自动回收');
      throw new SessionBridgeError('storage_error', '无法获取请求锁');
    }
    try { return await action(); }
    finally { rmdirSync(path); }
  }
  private require(requestId: string): StoredRequest {
    const record = this.read(requestId);
    if (!record) throw new SessionBridgeError('not_found', '会话创建请求不存在');
    return record;
  }
  private read(requestId: string): StoredRequest | undefined {
    return this.readRecord(this.filename(requestId), requestId);
  }
  private readRecord(path: string, expectedRequestId?: string): StoredRequest | undefined {
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw new SessionBridgeError('storage_error', '无法安全读取创建请求'); }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stats.uid !== process.getuid()) || stats.size > 16_384) throw new Error('unsafe request file');
      const record = JSON.parse(readFileSync(fd, 'utf8')) as StoredRequest;
      const parsedId = requestInput(record.request, true).requestId;
      if (record.version !== 1 || (expectedRequestId !== undefined && parsedId !== expectedRequestId) || this.filename(parsedId) !== path ||
          !Number.isSafeInteger(record.request.issuedAt) || record.request.issuedAt < 0 || record.request.expiresAt !== record.request.issuedAt + TTL_MS ||
          typeof record.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.nonce) || !['pending', 'claiming', 'claimed', 'abandoned'].includes(record.phase) ||
          ((record.phase === 'claiming' || record.phase === 'claimed') && (!record.targetId || record.targetId === record.request.issuerThreadId))) throw new Error('invalid request record');
      return record;
    } catch { throw new SessionBridgeError('storage_error', '创建请求文件损坏或权限不安全'); }
    finally { closeSync(fd); }
  }
  private write(record: StoredRequest): void {
    const path = this.filename(record.request.requestId), temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(record), 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
      const directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch { throw new SessionBridgeError('storage_error', '创建请求写入失败，请使用相同请求编号重试'); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
  }
}

function nonEmpty(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new SessionBridgeError('invalid_input', `${label}无效`);
  return value;
}
function requestInput(input: SessionRequestInput, persisted = false): SessionRequestInput {
  const allowed = ['requestId', 'issuerThreadId', 'projectId', 'hostProjectId', 'cardId', 'name', 'origin', ...(persisted ? ['issuedAt', 'expiresAt'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new SessionBridgeError('invalid_input', '创建请求参数不符合协议');
  if(input.origin!==undefined&&input.origin!=='assistant')throw new SessionBridgeError('invalid_input','创建请求来源不符合协议');
  return { requestId: nonEmpty(input.requestId, '请求编号'), issuerThreadId: nonEmpty(input.issuerThreadId, '宿主会话身份'),
    projectId: nonEmpty(input.projectId, '项目编号'), ...(input.hostProjectId!==undefined?{hostProjectId:nonEmpty(input.hostProjectId,'Codex 项目编号')}:{}), cardId: nonEmpty(input.cardId, '卡片编号'), ...(input.name !== undefined ? { name: nonEmpty(input.name, '会话名称', 240) } : {}),...(input.origin==='assistant'?{origin:'assistant' as const}:{}) };
}
function privateDirectory(path: string): void {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); }
  catch { throw new SessionBridgeError('storage_error', '无法创建私有请求目录'); }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) throw new SessionBridgeError('unsafe_storage', '请求目录必须为当前用户独有且不能是符号链接');
}
function errorCode(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined; }
