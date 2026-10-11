import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionBridge, type SessionBridgeOptions, type SessionRequestInput, type VerifiedSessionThread } from './session-bridge.ts';

const dirs: string[] = [];
const now = 1_800_000_000_000;
const request: SessionRequestInput = { requestId: 'request-1', issuerThreadId: 'issuer', projectId: 'project-1', cardId: 'card-1', name: '#1 合成卡片' };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(options: Partial<SessionBridgeOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cpm-session-bridge-')); dirs.push(dir);
  const calls: Parameters<SessionBridgeOptions['onClaim']>[0][] = [];
  const config: SessionBridgeOptions = { clock: () => now, onClaim: context => { calls.push(context); }, ...options };
  const bridge = new SessionBridge(dir, config);
  const verify = (id: string): VerifiedSessionThread => ({ id, projectId: 'project-1', createdAt: now, name: '合成新会话' });
  return { bridge, dir, config, calls, verify };
}

it('C-121 创建授权票据仅prepare回显随机nonce，状态与回调不泄漏nonce', async () => {
  const x = fixture(); const ticket = await x.bridge.prepare(request);
  expect(ticket).toMatchObject({ ...request, issuedAt: now, expiresAt: now + 300_000, status: 'pending' });
  expect(ticket.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const view = await x.bridge.status(request.requestId, request.issuerThreadId);
  expect(view).toEqual({ requestId: request.requestId, status: 'pending', issuedAt: now, expiresAt: now + 300_000 });
  expect(JSON.stringify(view)).not.toContain(ticket.nonce);
  const result = await x.bridge.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'new-thread' }, (id, publicRequest) => {
    expect(publicRequest).toEqual({ ...request, issuedAt: now, expiresAt: now + 300_000 });
    return x.verify(id);
  });
  expect(result).toEqual({ requestId: request.requestId, status: 'claimed', targetId: 'new-thread', duplicate: false });
  expect(x.calls).toHaveLength(1);
  expect(x.calls[0]).toMatchObject({ request: { ...request, issuedAt: now }, thread: { id: 'new-thread' }, eventKey: 'session-request:request-1' });
  expect(JSON.stringify(x.calls)).not.toContain(ticket.nonce);
  expect(await x.bridge.status(request.requestId, request.issuerThreadId)).toMatchObject({ status: 'claimed', targetId: 'new-thread' });
});

it('C-146 完全相同prepare跨实例幂等，不续期或更换nonce', async () => {
  const x = fixture(); const first = await x.bridge.prepare(request);
  const second = new SessionBridge(x.dir, { ...x.config, clock: () => now + 60_000 });
  expect(await second.prepare({ ...request })).toEqual(first);
});

it.each(['issuerThreadId', 'projectId', 'cardId', 'name'] as const)('C-146 同requestId但%s改变须拒绝', async field => {
  const x = fixture(); const first = await x.bridge.prepare(request);
  await expect(x.bridge.prepare({ ...request, [field]: 'different' })).rejects.toMatchObject({ code: 'request_conflict' });
  expect(await x.bridge.prepare(request)).toEqual(first);
});

it('C-121 查询状态必须属于票据issuer', async () => {
  const x = fixture(); await x.bridge.prepare(request);
  await expect(x.bridge.status(request.requestId, 'foreign-issuer')).rejects.toMatchObject({ code: 'forbidden' });
});

it('C-129 初次认领五分钟过期，不调用metadata或onClaim', async () => {
  const x = fixture(); const ticket = await x.bridge.prepare(request);
  const expired = new SessionBridge(x.dir, { ...x.config, clock: () => now + 300_000 });
  let verified = false;
  await expect(expired.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' }, id => { verified = true; return x.verify(id); })).rejects.toMatchObject({ code: 'expired' });
  expect(verified).toBe(false); expect(x.calls).toHaveLength(0);
  expect(await expired.status(request.requestId, request.issuerThreadId)).toMatchObject({ status: 'expired' });
});

it('C-129 metadata核验跨过TTL不能提交首次认领', async () => {
  let clock = now; const x = fixture({ clock: () => clock }); const ticket = await x.bridge.prepare(request);
  await expect(x.bridge.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' }, id => {
    clock = now + 300_000; return x.verify(id);
  })).rejects.toMatchObject({ code: 'expired' });
  expect(x.calls).toHaveLength(0);
  expect(await x.bridge.status(request.requestId, request.issuerThreadId)).toMatchObject({ status: 'expired' });
});

it('C-129 错nonce、issuer自身和缺宿主身份不能认领', async () => {
  const x = fixture(); const ticket = await x.bridge.prepare(request);
  for (const input of [
    { requestId: request.requestId, nonce: 'wrong', threadId: 'new' },
    { requestId: request.requestId, nonce: ticket.nonce, threadId: request.issuerThreadId },
    { requestId: request.requestId, nonce: ticket.nonce, threadId: '' },
  ]) await expect(x.bridge.claim(input, x.verify)).rejects.toBeInstanceOf(Error);
  expect(x.calls).toHaveLength(0);
});

it.each([
  { id: 'different', projectId: 'project-1', createdAt: now },
  { id: 'new', projectId: 'another-project', createdAt: now },
  { id: 'new', projectId: 'project-1', createdAt: now - 2001 },
  { id: 'new', projectId: 'project-1', createdAt: Number.NaN },
])('C-005 官方metadata身份/项目/创建时间不匹配不能认领：%j', async thread => {
  const x = fixture(); const ticket = await x.bridge.prepare(request);
  await expect(x.bridge.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' }, () => thread)).rejects.toMatchObject({ code: 'verification_failed' });
  expect(x.calls).toHaveLength(0);
  expect(await x.bridge.status(request.requestId, request.issuerThreadId)).toMatchObject({ status: 'pending' });
});

it('C-121 官方创建时间容许两秒边界，禁止把旧会话冒充新会话', async () => {
  const x = fixture(); const ticket = await x.bridge.prepare(request);
  const result = await x.bridge.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' }, id => ({ ...x.verify(id), createdAt: now - 2000 }));
  expect(result.status).toBe('claimed');
});

it('C-146 已认领同目标重试跨实例和过期仍幂等，另一目标拒绝', async () => {
  const x = fixture(); const ticket = await x.bridge.prepare(request);
  const input = { requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' };
  await x.bridge.claim(input, x.verify);
  const reopened = new SessionBridge(x.dir, { ...x.config, clock: () => now + 600_000 });
  expect(await reopened.claim(input, () => { throw new Error('重复不能再调用verify'); })).toMatchObject({ status: 'claimed', targetId: 'new', duplicate: true });
  await expect(reopened.claim({ ...input, threadId: 'other' }, x.verify)).rejects.toMatchObject({ code: 'target_conflict' });
  expect(x.calls).toHaveLength(1);
});

it('C-129 onClaim失败不宣称claimed；固定目标与eventKey可跨实例恢复', async () => {
  let fail = true; const keys: string[] = [];
  const x = fixture({ onClaim: context => { keys.push(context.eventKey); if (fail) throw new Error('模拟绑定失败'); } });
  const ticket = await x.bridge.prepare(request); const input = { requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' };
  await expect(x.bridge.claim(input, x.verify)).rejects.toMatchObject({ code: 'claim_failed' });
  expect(await x.bridge.status(request.requestId, request.issuerThreadId)).toMatchObject({ status: 'claiming', targetId: 'new' });
  await expect(x.bridge.claim({ ...input, threadId: 'other' }, x.verify)).rejects.toMatchObject({ code: 'target_conflict' });
  fail = false;
  const retry = new SessionBridge(x.dir, { ...x.config, clock: () => now + 400_000 });
  expect(await retry.claim(input, x.verify)).toMatchObject({ status: 'claimed' });
  expect(keys).toEqual(['session-request:request-1', 'session-request:request-1']);
});

it('C-146 同请求跨实例并发互斥，锁忙明确重试且不回收活锁', async () => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const x = fixture({ onClaim: async () => { entered(); await waiting; } });
  const ticket = await x.bridge.prepare(request); const input = { requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' };
  const first = x.bridge.claim(input, x.verify); await started;
  const other = new SessionBridge(x.dir, x.config);
  await expect(other.claim(input, x.verify)).rejects.toMatchObject({ code: 'busy' });
  expect(await other.status(request.requestId, request.issuerThreadId)).toMatchObject({ status: 'claiming' });
  release(); await first;
  expect(await other.claim(input, x.verify)).toMatchObject({ duplicate: true });
});

it('C-146 独立Node进程不能抢占另一进程已持有的请求锁', async () => {
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const x = fixture({ onClaim: async () => { entered(); await waiting; } });
  const ticket = await x.bridge.prepare(request); const input = { requestId: request.requestId, nonce: ticket.nonce, threadId: 'new' };
  const first = x.bridge.claim(input, x.verify); await started;
  try {
    const script = `import {SessionBridge} from ${JSON.stringify(new URL('./session-bridge.ts', import.meta.url).href)}; const bridge=new SessionBridge(${JSON.stringify(x.dir)},{clock:()=>${now},onClaim:()=>{throw new Error('不得执行')}});try{await bridge.claim(${JSON.stringify(input)},id=>({id,projectId:'project-1',createdAt:${now}}));console.log('unexpected');}catch(error){console.log(error.code);}`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    expect(child.status).toBe(0); expect(child.stdout.trim()).toBe('busy');
  } finally { release(); await first; }
});

it('C-146 不同请求有独立nonce与锁，一条认领等待不阻塞另一条', async () => {
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const x = fixture({ onClaim: async context => { if (context.request.requestId === request.requestId) { entered(); await waiting; } } });
  const firstTicket = await x.bridge.prepare(request);
  const first = x.bridge.claim({ requestId: request.requestId, nonce: firstTicket.nonce, threadId: 'first-new' }, x.verify);
  await started;
  try {
    const other = { ...request, requestId: 'independent' }; const secondTicket = await x.bridge.prepare(other);
    expect(secondTicket.nonce).not.toBe(firstTicket.nonce);
    expect(await x.bridge.claim({ requestId: other.requestId, nonce: secondTicket.nonce, threadId: 'second-new' }, x.verify)).toMatchObject({ status: 'claimed', targetId: 'second-new' });
  } finally { release(); await first; }
});

it('C-241 私有权限与原子票据文件，已有锁从不自动清理', async () => {
  const x = fixture(); await x.bridge.prepare(request); const directory = join(x.dir, 'session-requests');
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  const files = readdirSync(directory); expect(files).toHaveLength(1);
  expect(lstatSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
  expect(() => JSON.parse(readFileSync(join(directory, files[0]!), 'utf8'))).not.toThrow();
  const lock = join(directory, `${createHash('sha256').update(request.requestId).digest('hex')}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  await expect(x.bridge.prepare(request)).rejects.toMatchObject({ code: 'busy' });
  expect(lstatSync(lock).isDirectory()).toBe(true);
});

it('C-241 拒绝公开权限目录与符号链接票据目录', () => {
  const wide = mkdtempSync(join(tmpdir(), 'cpm-bridge-wide-')); dirs.push(wide); chmodSync(wide, 0o755);
  expect(() => new SessionBridge(wide, { onClaim() {} })).toThrow();
  const data = mkdtempSync(join(tmpdir(), 'cpm-bridge-link-')); dirs.push(data);
  const elsewhere = mkdtempSync(join(tmpdir(), 'cpm-bridge-target-')); dirs.push(elsewhere);
  symlinkSync(elsewhere, join(data, 'session-requests'));
  expect(() => new SessionBridge(data, { onClaim() {} })).toThrow();
});

it('C-121 list保留当前issuer过期待处理请求，不回显nonce且不含已完成', async () => {
  let clock = now; const x = fixture({ clock: () => clock });
  const ticket = await x.bridge.prepare(request);
  await x.bridge.prepare({ ...request, requestId: 'foreign', issuerThreadId: 'another-issuer' });
  const completed = await x.bridge.prepare({ ...request, requestId: 'completed' });
  await x.bridge.claim({ requestId: 'completed', nonce: completed.nonce, threadId: 'completed-thread' }, x.verify);
  const list = await x.bridge.list(request.issuerThreadId);
  expect(list).toEqual([{ ...request, status: 'pending', issuedAt: now, expiresAt: now + 300_000 }].map(({ issuerThreadId: _issuer, ...rest }) => rest));
  expect(JSON.stringify(list)).not.toContain(ticket.nonce);
  clock = now + 300_000;
  expect(await new SessionBridge(x.dir, x.config).list(request.issuerThreadId)).toEqual(list.map(item => ({ ...item, status: 'expired' })));
});

it('C-121 list保留已过期claiming的固定targetId以便刷新继续恢复', async () => {
  let clock = now, fail = true;
  const x = fixture({ clock: () => clock, onClaim() { if (fail) throw new Error('合成绑定待重试'); } });
  const ticket = await x.bridge.prepare(request);
  await expect(x.bridge.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'target' }, x.verify)).rejects.toMatchObject({ code: 'claim_failed' });
  clock = now + 300_000;
  const reopened = new SessionBridge(x.dir, x.config);
  expect(await reopened.list(request.issuerThreadId)).toEqual([
    { requestId: request.requestId, projectId: request.projectId, cardId: request.cardId, name: request.name, status: 'claiming', targetId: 'target', issuedAt: now, expiresAt: now + 300_000 },
  ]);
  fail = false;
  expect(await reopened.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'target' }, x.verify)).toMatchObject({ status: 'claimed', targetId: 'target' });
  expect(await reopened.list(request.issuerThreadId)).toEqual([]);
});

it.each([0, 300_000])('C-129 issuer明确放弃pending票据（经过%d毫秒）保留证据，重试prepare不复活且迟到claim拒绝', async elapsed => {
  let clock = now; const x = fixture({ clock: () => clock });
  const ticket = await x.bridge.prepare(request); clock += elapsed;
  const abandoned = await x.bridge.abandon(request.requestId, request.issuerThreadId);
  expect(abandoned).toEqual({ requestId: request.requestId, status: 'abandoned', issuedAt: now, expiresAt: now + 300_000 });
  expect(JSON.stringify(abandoned)).not.toContain(ticket.nonce);
  const reopened = new SessionBridge(x.dir, x.config);
  expect(await reopened.status(request.requestId, request.issuerThreadId)).toEqual(abandoned);
  expect(await reopened.abandon(request.requestId, request.issuerThreadId)).toEqual(abandoned);
  expect(await reopened.list(request.issuerThreadId)).toEqual([]);
  expect(await reopened.prepare(request)).toEqual({ ...ticket, status: 'abandoned' });
  let verified = false;
  await expect(reopened.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'late-target' }, id => { verified = true; return x.verify(id); })).rejects.toMatchObject({ code: 'abandoned' });
  expect(verified).toBe(false); expect(x.calls).toHaveLength(0);
  const files = readdirSync(join(x.dir, 'session-requests')); expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(x.dir, 'session-requests', files[0]!), 'utf8'))).toMatchObject({ phase: 'abandoned', request: { requestId: request.requestId } });
});

it('C-121 其他issuer不能放弃票据，失败不改变原票据', async () => {
  const x = fixture(); const ticket = await x.bridge.prepare(request);
  await expect(x.bridge.abandon(request.requestId, 'foreign-issuer')).rejects.toMatchObject({ code: 'forbidden' });
  expect(await x.bridge.prepare(request)).toEqual(ticket);
});

it.each(['claiming', 'claimed'] as const)('C-129 已进入%s的票据不能放弃，保留固定目标', async phase => {
  const x = fixture({ onClaim() { if (phase === 'claiming') throw new Error('合成绑定待恢复'); } });
  const ticket = await x.bridge.prepare(request);
  const claim = x.bridge.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'target' }, x.verify);
  if (phase === 'claiming') await expect(claim).rejects.toMatchObject({ code: 'claim_failed' }); else await claim;
  const before = await x.bridge.status(request.requestId, request.issuerThreadId);
  await expect(x.bridge.abandon(request.requestId, request.issuerThreadId)).rejects.toMatchObject({ code: 'invalid_state' });
  expect(await x.bridge.status(request.requestId, request.issuerThreadId)).toEqual(before);
  expect(before).toMatchObject({ status: phase, targetId: 'target' });
});

it('C-146 abandon与claim共享请求锁，不可取消进行中的绑定', async () => {
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const x = fixture({ onClaim: async () => { entered(); await waiting; } });
  const ticket = await x.bridge.prepare(request);
  const claim = x.bridge.claim({ requestId: request.requestId, nonce: ticket.nonce, threadId: 'target' }, x.verify);
  await started;
  try {
    const reopened = new SessionBridge(x.dir, x.config);
    await expect(reopened.abandon(request.requestId, request.issuerThreadId)).rejects.toMatchObject({ code: 'busy' });
    expect(await reopened.status(request.requestId, request.issuerThreadId)).toMatchObject({ status: 'claiming', targetId: 'target' });
  } finally { release(); await claim; }
});

it('C-241 list有界扫描，损坏或不安全权限必须明报', async () => {
  const x = fixture(); await x.bridge.prepare(request);
  const directory = join(x.dir, 'session-requests'), file = join(directory, readdirSync(directory)[0]!);
  chmodSync(file, 0o644);
  await expect(x.bridge.list(request.issuerThreadId)).rejects.toMatchObject({ code: 'storage_error' });
  chmodSync(file, 0o600);
  const { writeFileSync } = await import('node:fs'); writeFileSync(file, '{broken');
  await expect(x.bridge.list(request.issuerThreadId)).rejects.toMatchObject({ code: 'storage_error' });
  const y = fixture(); const other = join(y.dir, 'session-requests');
  for (let i = 0; i < 1001; i++) mkdirSync(join(other, `${i.toString(16).padStart(64, '0')}.lock`), { mode: 0o700 });
  await expect(y.bridge.list(request.issuerThreadId)).rejects.toMatchObject({ code: 'scan_limit' });
});
