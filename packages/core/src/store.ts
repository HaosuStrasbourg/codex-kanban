import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { businessDate, isValidFollowUpAt, matchesFollowUpView } from './dates.ts';
import type { Activity, Actor, Card, Change, ChecklistItem, CompletionPreview, Event, Evidence, Member, Notification, QueryOptions, QueryResult, Result, Session, State, Status } from './types.ts';

const statuses: Status[] = ['未开始', '计划中', '进行中', '待验收', '已完成', '暂停'];
const fields = ['title', 'description', 'tags', 'priority', 'dueDate', 'followUpOwner', 'followUpAt', 'status', 'progressText', 'nextStep'];
const reasonFields = ['title', 'description', 'tags', 'priority', 'dueDate', 'followUpOwner', 'followUpAt'];
const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const empty = (): State => ({ schemaVersion: 1, revision: 0, updatedAt: null, projects: [], cards: [], sessions: [], activities: [], notifications: [], preferences: {} });
const text = (v: unknown, label: string): string => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${label}不能为空`); return v; };
const object = (v: unknown, label: string): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label}须为对象`); return v as Record<string, unknown>; };
const strings = (v: unknown, label: string): string[] => { if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${label}须为字符串数组`); return v as string[]; };
const userLike = (a: Actor) => a.kind === 'user' || a.kind === 'user_instruction';
export type StoreOptions = { clock?: () => string; beforeSnapshotWrite?: () => void; busyTimeoutMs?: number };
type Context = { state: State; event: Event; at: string; revision: number; warnings: string[]; summary: string[]; approved: boolean; confirmation?: Result['confirmation']; cardId?: string };

/** One SQLite WAL database. Every domain mutation, including hooks, enters applyEvent. */
export class ProjectStore {
  private db: DatabaseSync;
  private options: StoreOptions;
  private prompts = new Map<string, { turnId: string; text: string }>();
  private syncError?: State['syncError'];
  private closed = false;
  private dbPath: string;
  constructor(dbPath: string, options: StoreOptions = {}) {
    this.dbPath = dbPath;
    this.options = options;
    const busyTimeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isInteger(busyTimeout) || busyTimeout < 0 || busyTimeout > 60000) throw new Error('数据库等待时限须为 0–60000 毫秒整数');
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(`PRAGMA busy_timeout=${busyTimeout};`);
      // Validate both version markers before WAL or schema initialization can alter
      // an unsupported database. Legacy SQLite version 0 still uses snapshot v1.
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 1) throw new Error('数据库版本高于插件支持版本，请使用匹配版本或先验证备份后决定恢复');
      if (version !== 0 && version !== 1) throw new Error('无法识别数据库版本，请使用匹配版本或先验证备份后决定恢复');
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshot'").get()) {
        const row = this.db.prepare('SELECT json FROM snapshot WHERE id=1').get() as { json: string } | undefined;
        if (row) {
          let snapshot: unknown;
          try { snapshot = JSON.parse(row.json); } catch { throw new Error('无法解析数据库快照版本，请使用匹配版本或先验证备份后决定恢复'); }
          if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || (snapshot as { schemaVersion?: unknown }).schemaVersion !== 1) throw new Error('无法识别或不支持数据库快照版本，请使用匹配版本或先验证备份后决定恢复');
        }
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      this.db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS activities (seq INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, report_key TEXT UNIQUE, json TEXT NOT NULL, result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS maintenance_events (event_id TEXT PRIMARY KEY, result TEXT NOT NULL); PRAGMA user_version=1; COMMIT;');
      if (!this.db.prepare('SELECT id FROM snapshot WHERE id=1').get()) this.db.prepare('INSERT OR IGNORE INTO snapshot(id,json) VALUES(1,?)').run(JSON.stringify(empty()));
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; this.prompts.clear(); } }
  private read(inWriteTransaction = false): State {
    const ownTransaction = !inWriteTransaction;
    if (ownTransaction) this.db.exec('BEGIN');
    try {
      const row = this.db.prepare('SELECT json FROM snapshot WHERE id=1').get() as { json: string };
      const state = JSON.parse(row.json) as State;
      state.activities = (this.db.prepare('SELECT json FROM activities ORDER BY seq').all() as { json: string }[]).map(row => JSON.parse(row.json) as Activity);
      if (ownTransaction) this.db.exec('COMMIT');
      return normalizePlanningFields(state);
    } catch (error) { if (ownTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  getState(): State { const state = this.read(); if (this.syncError) state.syncError = clone(this.syncError); return state; }
  registerPrompt(sessionId: string, turnId: string, prompt: string): void {
    const session = this.read().sessions.find(s => s.id === sessionId);
    if (!session?.turn || session.turn.id !== turnId || session.status !== '运行中') throw new Error('原话登记必须属于当前运行轮次');
    this.prompts.set(sessionId, { turnId, text: text(prompt, '当前轮原文') });
  }
  applyEvent(input: Event): Result {
    if (input.type === 'store.restore') {
      if (input.actor?.kind !== 'user') return { ok: false, status: 'rejected', errors: ['只有用户可以恢复备份'], warnings: [] };
      let restoring = false;
      try {
        text(input.id, '事件 ID');
        this.db.exec('BEGIN IMMEDIATE'); restoring = true;
        const previous = this.db.prepare('SELECT result FROM maintenance_events WHERE event_id=? UNION ALL SELECT result FROM activities WHERE event_id=? LIMIT 1').get(input.id, input.id) as { result: string } | undefined;
        if (previous) { this.db.exec('ROLLBACK'); restoring = false; return { ...JSON.parse(previous.result) as Result, status: 'duplicate' }; }
        this.restoreSnapshot(text(input.payload.path, '备份路径'));
        const result: Result = { ok: true, status: 'applied', errors: [], warnings: [] };
        this.db.prepare('INSERT INTO maintenance_events(event_id,result) VALUES(?,?)').run(input.id, JSON.stringify(result));
        this.db.exec('COMMIT'); restoring = false;
        this.prompts.clear(); this.syncError = undefined;
        return result;
      } catch (error) { if (restoring) this.db.exec('ROLLBACK'); return { ok: false, status: 'failed', errors: [error instanceof Error ? error.message : String(error)], warnings: [] }; }
    }
    let transaction = false;
    let before: State | undefined;
    try {
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      const e = clone(input);
      text(e.id, '事件 ID'); text(e.type, '事件类型'); object(e.payload, '事件数据');
      if (!e.actor || !['user','assistant','session','user_instruction','system'].includes(e.actor.kind)) throw new Error('无效的操作来源');
      if (['session','user_instruction'].includes(e.actor.kind) && (!e.sessionId || e.actor.id !== e.sessionId)) throw new Error('来源会话身份不一致');
      const reportKey = e.type === 'report.submit' && typeof e.payload.reportId === 'string' ? `${e.sessionId}:${e.payload.reportId}` : null;
      const requestDigest=e.type==='report.submit'?createHash('sha256').update(JSON.stringify(canonicalValue([e.sessionId,e.turnId,e.payload.reportId??e.id,e.payload]))).digest('hex'):undefined;
      const duplicate = this.db.prepare('SELECT seq,json,result FROM activities WHERE event_id=? OR (report_key IS NOT NULL AND report_key=?) UNION ALL SELECT NULL AS seq,NULL AS json,result FROM maintenance_events WHERE event_id=? LIMIT 1').get(e.id, reportKey, e.id) as { seq: number | null; json: string | null; result: string } | undefined;
      if (duplicate) {
        const r = JSON.parse(duplicate.result) as Result;
        if(e.type==='report.submit'&&r.status==='rejected'&&duplicate.json&&JSON.parse(duplicate.json).type==='report.submit'){
          // Legacy rejected receipts must not permanently reserve a report identity. Keep
          // their append-only activity JSON intact; only release the deduplication index.
          this.db.prepare('UPDATE activities SET event_id=?,report_key=NULL WHERE seq=?').run(`rejected:${randomUUID()}`,duplicate.seq);
        }else{this.db.exec('ROLLBACK'); transaction = false; return { ...r, status: 'duplicate' };}
      }
      if(requestDigest){
        const rejected=this.db.prepare("SELECT result FROM activities WHERE json_extract(json,'$.requestDigest')=? ORDER BY seq DESC LIMIT 1").get(requestDigest) as {result:string}|undefined;
        if(rejected){this.db.exec('ROLLBACK');transaction=false;return {...JSON.parse(rejected.result) as Result,status:'duplicate'};}
      }
      before = this.read(true);
      let state = clone(before);
      const at = e.at ?? this.options.clock?.() ?? new Date().toISOString();
      if (Number.isNaN(Date.parse(at))) throw new Error('事件时间无效');
      const ctx: Context = { state, event: e, at, revision: before.revision + 1, warnings: [], summary: [], approved: false, cardId: e.cardId };
      const errors: string[] = [];
      try { this.mutate(ctx); state = ctx.state; }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); state = clone(before); ctx.state = state; }
      if (ctx.confirmation) { this.db.exec('ROLLBACK'); transaction = false; return { ok: false, status: 'confirmation_required', errors: [], warnings: [], confirmation: ctx.confirmation }; }
      if (!errors.length) this.derive(ctx);
      state.revision = ctx.revision; state.updatedAt = at;
      for (const card of state.cards) {
        const previous = before.cards.find(c => c.id === card.id);
        if (!same(previous, card)) card.updatedAt = at;
      }
      const changes = diff(before, state);
      const activityId=before.activities.some(a=>a.id===`a:${e.id}`)?`a:${e.id}:retry:${state.revision}`:`a:${e.id}`;
      const activity: Activity = { id: activityId, eventId: e.id, revision: state.revision, cardId: ctx.cardId,
        projectId: e.projectId ?? state.cards.find(c => c.id === ctx.cardId)?.projectId, sessionId: e.sessionId, turnId: e.turnId,
        at, actor: e.actor, type: e.type, result: errors.length ? '已退回' : ctx.warnings.length ? '部分生效' : '已生效',
        ...(requestDigest?{requestDigest}:{}),
        summary: errors.length ? errors.join('；') : ctx.summary.join('；') || e.type, warnings: ctx.warnings, errors, changes,
        ...(e.type === 'instruction.apply' && !errors.length ? { quote: e.payload.quote as string } : {}),
        ...(typeof e.payload.reason === 'string' ? { reason: e.payload.reason } : {}), collapsed: e.type === 'report.submit' && e.payload.noChange === true };
      const result: Result = { ok: !errors.length, status: errors.length ? 'rejected' : ctx.warnings.length ? 'partial' : 'applied', activityId: activity.id, cardId: ctx.cardId, errors, warnings: ctx.warnings };
      // Write the append-only activity first. A process death here must roll back both rows.
      const rejectedReport=e.type==='report.submit'&&errors.length>0;
      this.db.prepare('INSERT INTO activities(seq,event_id,report_key,json,result) VALUES(?,?,?,?,?)').run(state.revision, rejectedReport?`rejected:${randomUUID()}`:e.id, rejectedReport?null:reportKey, JSON.stringify(activity), JSON.stringify(result));
      this.options.beforeSnapshotWrite?.();
      this.db.prepare('UPDATE snapshot SET json=? WHERE id=1').run(JSON.stringify({ ...state, activities: [] }));
      this.db.exec('COMMIT'); transaction = false; this.syncError = undefined;
      if (!errors.length && e.type === 'turn.start' && e.sessionId) {
        if (before.sessions.find(s => s.id === e.sessionId)?.turn?.id !== e.turnId) this.prompts.delete(e.sessionId);
        if (typeof e.payload.userMessage === 'string') this.registerPrompt(e.sessionId, e.turnId!, e.payload.userMessage);
      }
      if (!errors.length && e.type === 'turn.end' && e.sessionId) this.prompts.delete(e.sessionId);
      return result;
    } catch (error) {
      if (transaction) { try { this.db.exec('ROLLBACK'); } catch { /* original write error remains authoritative */ } }
      const message = error instanceof Error ? error.message : String(error);
      let lastUpdatedAt = before?.updatedAt ?? null;
      if (!before) { try { lastUpdatedAt = this.read().updatedAt; } catch { /* unavailable storage has no trustworthy newer timestamp */ } }
      this.syncError = { message: `同步失败：${message}`, lastUpdatedAt };
      return { ok: false, status: 'failed', errors: [this.syncError.message], warnings: [] };
    }
  }
  private getCard(ctx: Context, id = ctx.event.cardId): Card {
    const card = ctx.state.cards.find(c => c.id === id && !c.deleted);
    if (!card) throw new Error('卡片不存在');
    ctx.cardId = card.id;
    if (ctx.event.actor.kind === 'session' || ctx.event.actor.kind === 'user_instruction') {
      const s = this.getSession(ctx);
      const target = s.turn?.cardId ?? s.cardId;
      if (target !== card.id) throw new Error('只能修改本会话绑定的卡片，请到目标卡片的会话或侧栏操作');
    }
    return card;
  }
  private getSession(ctx: Context, newTurn = false): Session {
    const session = ctx.state.sessions.find(s => s.id === ctx.event.sessionId);
    if (!session) throw new Error('会话不存在，请先登记并绑定');
    if (!newTurn && ctx.event.turnId && ctx.event.turnId !== session.turn?.id) throw new Error('报告轮次已过期');
    return session;
  }
  private user(ctx: Context): void { if (ctx.event.actor.kind !== 'user') throw new Error('只有用户在侧栏可以执行此操作'); }
  private metadata(ctx: Context): void { if (!['user','system'].includes(ctx.event.actor.kind)) throw new Error('只有可信宿主可以更新项目或会话元数据'); }
  private assistantRequest(ctx: Context): void {
    const { event: e, state: s } = ctx;
    if (e.actor.kind !== 'assistant') return;
    if (e.type !== 'card.create' && e.type !== 'session.bind') throw new Error('AI代办仅允许创建卡片或绑定会话');
    const issuerId = text(e.actor.id, 'AI代办发起会话 ID');
    const issuer = s.sessions.find(session => session.id === issuerId);
    if (!issuer || !e.projectId || issuer.projectId !== e.projectId || !s.projects.some(project => project.id === e.projectId))
      throw new Error('AI代办必须由已登记的同一项目发起会话提交');
    const allowed = e.type === 'card.create'
      ? ['title', 'description', 'tags', 'priority', 'dueDate', 'followUpOwner', 'followUpAt', 'acceptance']
      : ['cardId', 'cardNo', 'expectedCurrentCardId'];
    if (Object.keys(e.payload).some(key => !allowed.includes(key))) throw new Error('AI代办包含不允许的字段');
    if (e.type === 'card.create') {
      if (e.sessionId !== undefined && e.sessionId !== issuerId) throw new Error('AI代办创建的发起会话身份不一致');
    } else {
      const target = s.sessions.find(session => session.id === e.sessionId);
      if (!target || target.projectId !== e.projectId) throw new Error('AI代办只能绑定同一项目的已登记会话');
      if (target.status === '已归档' || target.status === '找不到') throw new Error('目标会话不可用，不能绑定');
    }
  }
  private mutate(ctx: Context): void {
    const { event: e, state: s, at } = ctx, p = e.payload;
    this.assistantRequest(ctx);
    switch (e.type) {
      case 'project.upsert': {
        this.metadata(ctx);
        const id = text(p.id, '项目 ID'), name = text(p.name, '项目名'), folder = text(p.folder, '文件夹');
        const hasMapping = Object.hasOwn(p, 'hostProjectId');
        const previous = s.projects.find(project => project.id === id);
        // Official discovery may register a new canonical identity as itself;
        // it cannot choose or replace the mapping of an existing local project.
        if (hasMapping && e.actor.kind !== 'user' && !(e.actor.kind === 'system' && !previous && p.hostProjectId === id)) throw new Error('只有用户可以明确选择 Codex 项目映射');
        const hostProjectId = hasMapping ? text(p.hostProjectId, 'Codex 项目 ID') : undefined;
        if (hostProjectId !== undefined && hostProjectId.length > 240) throw new Error('Codex 项目 ID 不能超过 240 个字符');
        if (previous) {
          const folderChanged = previous.folder !== folder;
          if (folderChanged && previous.hostProjectId && e.actor.kind !== 'user') throw new Error('目录变更涉及用户指定的 Codex 项目映射，须由用户重新确认');
          if (folderChanged && !hasMapping) delete previous.hostProjectId;
          Object.assign(previous, { name, folder });
          if (hostProjectId !== undefined) previous.hostProjectId = hostProjectId;
        } else s.projects.push({ id, name, folder, nextNo: 1, ...(hostProjectId !== undefined ? { hostProjectId } : {}) });
        return;
      }
      case 'session.upsert': {
        this.metadata(ctx); const id = text(p.id,'会话 ID'), projectId = text(p.projectId,'项目 ID');
        if (!s.projects.some(project => project.id === projectId)) throw new Error('会话必须属于已登记项目，第一版不支持无项目会话');
        const existing = s.sessions.find(session => session.id === id);
        if (existing?.cardId && existing.projectId !== projectId) throw new Error('已绑定会话不能改项目');
        const status = (p.status ?? existing?.status ?? '空闲') as Session['status'];
        if (!['运行中','空闲','已归档','找不到'].includes(status)) throw new Error('会话状态无效');
        let lastActivityAt = at;
        if (Object.hasOwn(p, 'lastActivityAt')) {
          const supplied = text(p.lastActivityAt, '最近活动时间'), timestamp = Date.parse(supplied);
          if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== supplied) throw new Error('最近活动时间须为有效 UTC ISO 时间');
          lastActivityAt = existing && Date.parse(existing.lastActivityAt) > timestamp ? existing.lastActivityAt : supplied;
        }
        if (existing) Object.assign(existing, { name: typeof p.name === 'string' ? p.name : existing.name, status, projectId, lastActivityAt });
        else s.sessions.push({ id, name: text(p.name,'会话名'), projectId, status, lastActivityAt }); return;
      }
      case 'card.create': {
        if (e.actor.kind !== 'assistant') this.user(ctx);
        const project = s.projects.find(project => project.id === e.projectId); if (!project) throw new Error('项目不存在');
        const id = typeof p.id === 'string' ? p.id : randomUUID(); if (s.cards.some(c => c.id === id)) throw new Error('卡片 ID 已存在');
        const newCard: Card = { id, projectId: project.id, no: project.nextNo++, title: text(p.title,'标题'), description: '', tags: [], priority: '中', dueDate: null, followUpOwner: '我', followUpAt: null, status: '未开始', progressText: '', nextStep: '', archived: false, deleted: false, order: s.cards.length, createdAt: at, updatedAt: at, checklist: [], acceptance: [], blockers: [], members: [], artifacts: [], conflicts: [], flags: [], progress: null, fieldRevisions: {}, needsSync: false };
        for (const field of ['description','tags','priority','dueDate','followUpOwner','followUpAt']) if (p[field] !== undefined) { this.validateField(field,p[field]); (newCard as unknown as Record<string,unknown>)[field] = clone(p[field]); }
        if (p.acceptance !== undefined) for (const content of strings(p.acceptance,'验收项')) newCard.acceptance.push(this.item(ctx, { content }));
        s.cards.push(newCard); ctx.cardId = id; ctx.summary.push('新建卡片'); return;
      }
      case 'card.update': this.updateFields(ctx, this.getCard(ctx), object(p.fields,'字段'), typeof p.reason === 'string' ? p.reason : undefined, objectOrEmpty(p.reasons)); return;
      case 'card.complete': { this.user(ctx); const c = this.getCard(ctx); this.setField(ctx,c,'status','已完成','用户确认完成'); ctx.summary.push('用户确认完成；未验收项保持原样'); return; }
      case 'card.archive': { this.user(ctx); const c = this.getCard(ctx); c.archived = p.archived !== false; return; }
      case 'card.delete': { this.user(ctx); const c = this.getCard(ctx); if (!c.archived) throw new Error('归档后才能删除'); c.deleted = true; for (const session of s.sessions) if(session.cardId === c.id) { delete session.cardId; delete session.pendingCardId; } c.members=[]; return; }
      case 'card.reorder': { this.user(ctx); const c=this.getCard(ctx); if(typeof p.order!=='number'||!Number.isFinite(p.order))throw new Error('排序值须为有限数字');c.order=p.order;return; }
      case 'checklist.add': case 'checklist.update': case 'checklist.delete': case 'checklist.check': case 'acceptance.evidence': case 'acceptance.reject': case 'blocker.resolve': this.listMutation(ctx); return;
      case 'artifact.add': { const c=this.getCard(ctx);c.artifacts.push({id:randomUUID(),title:text(p.title,'成果标题'),link:text(p.link,'成果链接'),source:clone(e.actor),at});return; }
      case 'artifact.delete': { const c=this.getCard(ctx); const index=c.artifacts.findIndex(a=>a.id===p.artifactId);if(index<0)throw new Error('成果不存在');c.artifacts.splice(index,1);return; }
      case 'session.bind': {
        if (e.actor.kind === 'session' || e.actor.kind === 'system') throw new Error('会话自动报告不允许绑定成员');
        const session = this.getSession(ctx);
        if(e.actor.kind==='user'){
          if(Object.hasOwn(p,'expectedCurrentCardId')&&p.expectedCurrentCardId!==(session.cardId??null))throw new Error('当前绑定已变化，请重新核对后确认');
          if(Object.hasOwn(p,'expectedPendingCardId')&&p.expectedPendingCardId!==(session.pendingCardId??null))throw new Error('待生效绑定已变化，请重新核对后确认');
        }
        const target = s.cards.find(c=>!c.deleted && (c.id === (e.cardId ?? p.cardId) || (p.cardNo === c.no && c.projectId === session.projectId)));
        if (!target) throw new Error('找不到本项目卡片，第一版不支持无项目绑定');
        if(target.projectId!==session.projectId)throw new Error('只能绑定同一项目的会话');
        if(e.actor.kind==='assistant'){
          if(target.archived)throw new Error('不能绑定已归档卡片');
          if((e.cardId!==undefined && e.cardId!==target.id) || (p.cardId!==undefined && p.cardId!==target.id) || (p.cardNo!==undefined && p.cardNo!==target.no))
            throw new Error('AI代办绑定目标不一致');
          if(session.pendingCardId && session.pendingCardId!==target.id)throw new Error('已有待换绑请求，不能覆盖或取消');
          if(Object.hasOwn(p,'expectedCurrentCardId') && p.expectedCurrentCardId!==session.cardId)throw new Error('当前绑定与AI代办预期不一致');
          if(session.cardId && session.cardId!==target.id && p.expectedCurrentCardId!==session.cardId)throw new Error('AI代办换绑必须明确当前卡片');
        }
        ctx.cardId=target.id;
        if(session.cardId===target.id)return;
        if(session.cardId && e.actor.kind==='user' && p.confirmed!==true){ctx.confirmation={fromCardId:session.cardId,toCardId:target.id};return;}
        if(e.actor.kind==='user_instruction'){
          const prompt=this.prompts.get(session.id);if(!prompt||prompt.turnId!==session.turn?.id)throw new Error('原话核对失败');
          const command=normalizeCommand(prompt.text);
          const match=/^(?:请|现在请|现在|帮我|请帮我)?(?:把(?:这个|当前)?会话)?(?:绑定到|挂到)#?(\d+)(?:号卡)?$/.exec(command);
          if(!match||Number(match[1])!==target.no)throw new Error('原话未明确要求绑定此卡片');
        }
        if(session.status==='运行中' && session.cardId){session.pendingCardId=target.id;ctx.summary.push('本轮结束后换绑，当前报告仍归原卡');}
        else this.bindNow(ctx,session,target);return;
      }
      case 'session.unbind': { this.user(ctx);const session=this.getSession(ctx);if(session.cardId){const c=s.cards.find(c=>c.id===session.cardId)!;ctx.cardId=c.id;c.members=c.members.filter(m=>m.sessionId!==session.id);}delete session.cardId;delete session.pendingCardId;return; }
      case 'session.create_failed': {this.metadata(ctx);const c=this.getCard(ctx);c.sessionCreationError=`创建失败，可重试${typeof p.message==='string'?`：${p.message}`:''}`;return;}
      case 'turn.start': {
        if(e.actor.kind!=='system')throw new Error('只有system宿主事件可以开启回合');
        const session=this.getSession(ctx,true);text(e.turnId,'轮次 ID');
        if(p.userMessage!==undefined)text(p.userMessage,'当前轮原文');
        if(session.turn?.id===e.turnId)return;
        const priorStarts=s.activities.filter(a=>a.sessionId===session.id&&a.type==='turn.start'&&a.result!=='已退回');
        if(priorStarts.some(a=>a.turnId===e.turnId))throw new Error('此回合已收尾，不可重新开启旧回合');
        const lastNumber=priorStarts.reduce((latest,a)=>{
          const saved=a.changes.find(c=>c.collection==='sessions'&&c.id===session.id&&c.field==='turn')?.after as Session['turn'];
          return Math.max(latest,saved?.number??0);
        },session.turn?.number??0);
        if(p.number!==undefined&&(!Number.isInteger(p.number)||Number(p.number)<1))throw new Error('回合序号须为正整数');
        // A new trusted prompt proves the previous round has ended even if its Stop was lost.
        // Close its reporting/binding state before capturing the new round's card and base revision.
        if(session.turn)this.finishTurn(ctx,session,false,true);
        session.turn={id:e.turnId!,number:typeof p.number==='number'?p.number:lastNumber+1,baseRevision:s.revision,cardId:session.cardId,reported:false};session.status='运行中';session.lastActivityAt=at;ctx.cardId=session.cardId;
        if(session.bindingChanged){ctx.summary.push(`当前卡片已改为 #${s.cards.find(c=>c.id===session.cardId)?.no}`);session.bindingChanged=false;}return;
      }
      case 'turn.end': {
        this.metadata(ctx);const session=this.getSession(ctx);
        if(Object.hasOwn(p,'expectedTurnId')&&p.expectedTurnId!==session.turn?.id)throw new Error('当前回合已变化，请重新核对恢复目标');
        this.finishTurn(ctx,session,p.interrupted===true);return;
      }
      case 'report.submit': this.report(ctx); return;
      case 'instruction.apply': this.instruction(ctx); return;
      case 'notification.resolve': { this.user(ctx);const n=s.notifications.find(n=>n.id===p.notificationId);if(!n)throw new Error('通知不存在');n.status='已处理';n.resolvedAt=at;ctx.cardId=n.cardId;return; }
      case 'activity.undo': {
        this.user(ctx);const a=s.activities.find(a=>a.id===p.activityId);if(!a)throw new Error('活动不存在');if(!a.changes.length)throw new Error('此活动没有可撤销改动');
        for(const change of [...a.changes].reverse()){
          // Monotone project numbering is never rewound, even if creation is undone.
          if(change.collection==='projects' && change.field==='nextNo')continue;
          if(change.collection==='cards'&&change.field==='fieldRevisions')continue;
          if(change.collection==='cards'&&change.field==='members')continue;
          // A business undo must not resurrect an ended turn or rewind current host state.
          if(change.collection==='sessions'&&['turn','status','lastActivityAt'].includes(change.field??''))continue;
          if(change.collection==='cards'&&['flags','progress','updatedAt'].includes(change.field??''))continue;
          if(a.type==='report.submit'&&change.collection==='cards'&&change.field==='needsSync')continue;
          if(change.collection==='cards'&&['checklist','acceptance','blockers','artifacts','conflicts'].includes(change.field??'')){
            const card=s.cards.find(c=>c.id===change.id);if(!card)throw new Error('无法撤销：目标卡片不存在');
            const key=change.field as 'checklist'|'acceptance'|'blockers'|'artifacts'|'conflicts';
            const previous=clone(card[key]);
            (card as unknown as Record<string,unknown>)[key]=undoArrayDelta(card[key],change.before as unknown[],change.after as unknown[]);
            if(['checklist','acceptance','blockers'].includes(key)){
              for(const item of [...previous,...card[key]] as ChecklistItem[]){
                const old=(previous as ChecklistItem[]).find(i=>i.id===item.id),next=(card[key] as ChecklistItem[]).find(i=>i.id===item.id);
                for(const field of new Set([...Object.keys(old??{}),...Object.keys(next??{})]))if(!same((old as unknown as Record<string,unknown>|undefined)?.[field],(next as unknown as Record<string,unknown>|undefined)?.[field]))
                  card.fieldRevisions[`${key}:${item.id}:${field}`]={revision:ctx.revision,actor:clone(e.actor),reason:'用户撤销'};
              }
            }
            continue;
          }
          applyChange(s,{...change,after:change.before,afterExists:change.beforeExists});
          if(change.collection==='cards'&&change.field&&fields.includes(change.field)){const c=s.cards.find(c=>c.id===change.id);if(c)c.fieldRevisions[change.field]={revision:ctx.revision,actor:e.actor,reason:'用户撤销'};}
        }
        this.restoreMembershipChanges(ctx,a.changes);
        ctx.cardId=a.cardId;ctx.summary.push(`撤销 ${a.id}`);return;
      }
      case 'comment.add': {this.getCard(ctx);ctx.summary.push(text(p.content,'评论'));return;}
      case 'preferences.update': {this.user(ctx);const key=text(p.key,'偏好键');if(['__proto__','prototype','constructor'].includes(key))throw new Error('偏好键无效');s.preferences[key]=clone(p.value);return;}
      case 'sync.missing': {this.metadata(ctx);const c=this.getCard(ctx);c.needsSync=true;ctx.summary.push('发现未送达报告，待补同步');return;}
      case 'sync.failed': {this.metadata(ctx);const c=this.getCard(ctx);this.notify(ctx,c,'sync-failed','同步失败');return;}
      case 'sync.recovered': {this.metadata(ctx);const c=this.getCard(ctx);for(const n of s.notifications)if(n.cardId===c.id&&n.type==='同步失败'){n.active=false;n.status='已处理';n.resolvedAt=at;}return;}
      default: throw new Error(`不支持的事件类型：${String(e.type)}`);
    }
  }
  private finishTurn(ctx:Context,session:Session,interrupted:boolean,missingStop=false):void {
    const turn=session.turn;ctx.cardId=turn?.cardId??session.cardId;
    if(turn){
      const card=ctx.state.cards.find(c=>c.id===turn.cardId);
      const prefix=missingStop&&card?`#${card.no} `:'';
      if(interrupted)ctx.summary.push(`第 ${turn.number} 轮被中断`);
      else if(!turn.reported&&card){card.needsSync=true;ctx.summary.push(`${prefix}第 ${turn.number} 轮没有报告${missingStop?'（结束信号缺失，已在新轮开始时收尾）':''}`);}
      else if(missingStop)ctx.summary.push(`${prefix}第 ${turn.number} 轮${turn.reported?'已报告':'未绑定卡片'}，结束信号缺失，已收尾`);
    }
    session.status='空闲';session.lastActivityAt=ctx.at;delete session.turn;
    if(session.pendingCardId){
      const target=ctx.state.cards.find(c=>c.id===session.pendingCardId&&!c.deleted);
      if(target)this.bindNow(ctx,session,target);
      delete session.pendingCardId;
    }
  }
  private validateField(field: string, value: unknown): void {
    if(!fields.includes(field))return;
    if(field==='status'&&!statuses.includes(value as Status))throw new Error('状态无效，须为未开始、计划中、进行中、待验收、已完成或暂停');
    else if(field==='priority'&&!['高','中','低'].includes(value as string))throw new Error('优先级无效');
    else if(field==='tags')strings(value,'标签');
    else if(field==='dueDate'&&value!==null&&(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))throw new Error('截止日期须为真实有效的 YYYY-MM-DD');
    else if(field==='followUpAt'&&value!==null&&!isValidFollowUpAt(value))throw new Error('跟进时间须为有效且带时区的 ISO 时间，未安排请用 null');
    else if(['title','description','progressText','nextStep','followUpOwner'].includes(field)&&typeof value!=='string')throw new Error(`${field}须为字符串`);
    if(field==='title'&&typeof value==='string'&&!value.trim())throw new Error('标题不能为空');
  }
  private updateFields(ctx: Context,c: Card, patch: Record<string,unknown>,reason?:string,reasons:Record<string,unknown>={}):void {
    for(const [field,value] of Object.entries(patch))this.validateField(field,value);
    for(const [field,raw] of Object.entries(patch)){
      if(!fields.includes(field)){ctx.warnings.push(`${field} 已忽略：不允许直接修改`);continue;}
      const because=typeof reasons[field]==='string'?reasons[field] as string:reason;
      let value=raw;
      const sessionActor=ctx.event.actor.kind==='session';
      if(sessionActor){
        const session=this.getSession(ctx),last=c.fieldRevisions[field];
        if(session.turn&&last&&last.revision>session.turn.baseRevision&&(last.actor.id!==ctx.event.actor.id||userLike(last.actor))){
          if(userLike(last.actor)){ctx.warnings.push(`${field} 已忽略：以用户修改为准`);continue;}
          const conflict={id:randomUUID(),field,current:clone((c as unknown as Record<string,unknown>)[field]),proposed:clone(value),currentSource:last.actor,proposedSource:ctx.event.actor,currentReason:last.reason,proposedReason:because,resolved:false};
          c.conflicts.push(conflict);ctx.warnings.push(`${field} 有冲突，保留当前值`);continue;
        }
        if(reasonFields.includes(field)&&!because?.trim()){ctx.warnings.push(`${field} 已忽略：未写原因`);continue;}
        if(field==='status'){
          if(value==='已完成'){value='待验收';ctx.summary.push('会话报告已完成，按规则记为待验收');}
          if(value==='待验收'&&c.blockers.some(item=>item.blocking&&!item.checked)){ctx.warnings.push('需先解除卡点');continue;}
          const natural=c.status===value||(c.status==='未开始'&&(value==='计划中'||value==='进行中'))||(c.status==='计划中'&&value==='进行中')||(c.status==='进行中'&&value==='待验收');
          if(!natural&&!because?.trim()){ctx.warnings.push('状态变化须写原因');continue;}
          if(c.status==='已完成'&&value!=='已完成')this.notify(ctx,c,`reopened:${ctx.event.id}`,'已完成的卡片被会话重新打开');
        }
      }else if(field==='status'&&value==='已完成'&&!ctx.approved){ctx.warnings.push('请使用确认完成操作，先查看未验收项和卡点');continue;}
      this.setField(ctx,c,field,value,because);
    }
  }
  private setField(ctx:Context,c:Card,field:string,value:unknown,reason?:string):void {
    (c as unknown as Record<string,unknown>)[field]=clone(value);
    c.fieldRevisions[field]={revision:ctx.revision,actor:clone(ctx.event.actor),...(reason?{reason}:{})};
    if(userLike(ctx.event.actor))for(const conflict of c.conflicts)if(conflict.field===field)conflict.resolved=true;
  }
  private item(ctx:Context,p:Record<string,unknown>):ChecklistItem {
    return {id:randomUUID(),content:text(p.content,'清单内容'),checked:false,source:clone(ctx.event.actor),evidence:[],rejected:false,acceptanceState:'未验收',...(typeof p.reason==='string'?{reason:p.reason}:{})};
  }
  private allowItemChange(ctx:Context,c:Card,list:string,item:ChecklistItem,field:string,value:unknown):boolean {
    if(ctx.event.actor.kind!=='session')return true;
    const session=this.getSession(ctx),key=`${list}:${item.id}:${field}`,last=c.fieldRevisions[key];
    if(!session.turn||!last||last.revision<=session.turn.baseRevision||last.actor.id===ctx.event.actor.id&&!userLike(last.actor))return true;
    if(userLike(last.actor)){ctx.warnings.push(`${key} 已忽略：以用户修改为准`);return false;}
    c.conflicts.push({id:randomUUID(),field:key,current:clone((item as unknown as Record<string,unknown>)[field]??null),proposed:clone(value),currentSource:clone(last.actor),proposedSource:clone(ctx.event.actor),currentReason:last.reason,proposedReason:typeof ctx.event.payload.reason==='string'?ctx.event.payload.reason:undefined,resolved:false});
    ctx.warnings.push(`${key} 有冲突，保留当前值`);return false;
  }
  private setItemField(ctx:Context,c:Card,list:string,item:ChecklistItem,field:string,value:unknown):void {
    (item as unknown as Record<string,unknown>)[field]=clone(value);
    const key=`${list}:${item.id}:${field}`,reason=ctx.event.payload.reason??ctx.event.payload.basis;
    c.fieldRevisions[key]={revision:ctx.revision,actor:clone(ctx.event.actor),...(typeof reason==='string'?{reason}:{})};
    if(userLike(ctx.event.actor))for(const conflict of c.conflicts)if(conflict.field===key)conflict.resolved=true;
  }
  private listMutation(ctx:Context):void {
    const {event:e}=ctx,p=e.payload,c=this.getCard(ctx);
    const list=e.type.startsWith('acceptance.')?'acceptance':e.type==='blocker.resolve'?'blockers':p.list;
    if(!['checklist','acceptance','blockers'].includes(list as string))throw new Error('清单类型无效');
    const items=c[list as 'checklist'|'acceptance'|'blockers'];
    const isSession=e.actor.kind==='session';
    if(e.type==='checklist.add'){
      const item=this.item(ctx,p);
      if(list==='blockers'){if(p.waitingFor!==undefined&&!['我','外部'].includes(p.waitingFor as string))throw new Error('卡点在等谁须为我或外部');item.blocking=p.blocking===true;item.waitingFor=(p.waitingFor??'我') as '我'|'外部';}
      items.push(item);return;
    }
    if(e.type==='blocker.resolve'&&(!p.itemId||typeof p.basis!=='string'||!p.basis.trim()))throw new Error('须指明卡点和依据');
    const item=items.find(item=>item.id===p.itemId);if(!item)throw new Error('清单项不存在');
    if(e.type==='checklist.update'||e.type==='checklist.delete'){
      if(list==='acceptance'&&isSession&&(item.source.kind!=='session'||item.source.id!==e.actor.id||item.checked))throw new Error('会话只可修改自己新增且未验收的项');
      if(e.type==='checklist.delete'){
        for(const field of Object.keys(item))if(!this.allowItemChange(ctx,c,String(list),item,field,null))return;
        items.splice(items.indexOf(item),1);return;
      }
      if(p.content!==undefined){const value=text(p.content,'清单内容');if(this.allowItemChange(ctx,c,String(list),item,'content',value))this.setItemField(ctx,c,String(list),item,'content',value);}
      if(list==='blockers'){
        if(p.blocking!==undefined){if(typeof p.blocking!=='boolean')throw new Error('是否阻断须为布尔值');if(this.allowItemChange(ctx,c,'blockers',item,'blocking',p.blocking))this.setItemField(ctx,c,'blockers',item,'blocking',p.blocking);}
        if(p.waitingFor!==undefined){if(!['我','外部'].includes(p.waitingFor as string))throw new Error('卡点在等谁无效');if(this.allowItemChange(ctx,c,'blockers',item,'waitingFor',p.waitingFor))this.setItemField(ctx,c,'blockers',item,'waitingFor',p.waitingFor);}
      }return;
    }
    if(e.type==='checklist.check'){
      if(list==='acceptance'&&(isSession||e.actor.kind==='user_instruction'&&!ctx.approved))throw new Error('会话自动报告不能勾选验收项');
      if(list==='acceptance'&&e.actor.kind==='system')throw new Error('验收只能由用户确认');
      if(list==='blockers')throw new Error('解除卡点须使用解除操作并提供依据');
      if(typeof p.checked!=='boolean')throw new Error('勾选值须为布尔值');if(this.allowItemChange(ctx,c,String(list),item,'checked',p.checked))this.setItemField(ctx,c,String(list),item,'checked',p.checked);return;
    }
    if(e.type==='acceptance.reject'){
      if(isSession||e.actor.kind==='system'||e.actor.kind==='user_instruction'&&!ctx.approved)throw new Error('只有用户可以不认可验收证据');this.setItemField(ctx,c,'acceptance',item,'rejected',true);this.setItemField(ctx,c,'acceptance',item,'checked',false);return;
    }
    if(e.type==='acceptance.evidence'){
      const ev=object(p.evidence,'证据');if(!['document','command','conversation'].includes(ev.kind as string))throw new Error('证据类型无效');
      const evidence:Evidence={kind:ev.kind as Evidence['kind'],reference:text(ev.reference,'证据路径、命令或回合'),detail:text(ev.detail,'章节、结果或摘要')};
      item.evidence.push(evidence);item.rejected=false;return;
    }
    if(e.type==='blocker.resolve'){
      const basis=text(p.basis,'解除依据');
      if(!this.allowItemChange(ctx,c,'blockers',item,'checked',true)||!this.allowItemChange(ctx,c,'blockers',item,'resolution',basis))return;
      this.setItemField(ctx,c,'blockers',item,'checked',true);this.setItemField(ctx,c,'blockers',item,'resolution',basis);return;
    }
  }
  private bindNow(ctx:Context,session:Session,target:Card):void {
    const old=ctx.state.cards.find(c=>c.id===session.cardId);if(old)old.members=old.members.filter(m=>m.sessionId!==session.id);
    target.members.push({sessionId:session.id,projectId:session.projectId,name:session.name,role:target.members.some(m=>m.role==='主会话')?'协作会话':'主会话',status:session.status,joinedAt:ctx.at});
    session.bindingChanged=Boolean(session.cardId&&session.cardId!==target.id);session.cardId=target.id;delete target.sessionCreationError;
    if(session.turn&&!session.turn.cardId)session.turn.cardId=target.id;
    ctx.summary.push(`已绑定到 #${target.no}`);
  }
  private restoreMembershipChanges(ctx:Context,changes:Change[]):void {
    const affected = new Set<string>();
    const previousMembers = new Map<string,Member>();
    for(const change of changes){
      if(change.collection==='sessions'&&(!change.field||['cardId','pendingCardId'].includes(change.field)))affected.add(change.id);
      if(change.collection!=='cards'||change.field!=='members')continue;
      const before=change.before as Member[],after=change.after as Member[];
      for(const id of new Set([...before.map(m=>m.sessionId),...after.map(m=>m.sessionId)])){
        const old=before.find(m=>m.sessionId===id),next=after.find(m=>m.sessionId===id);
        if(same(old,next))continue;
        affected.add(id);if(old)previousMembers.set(`${change.id}:${id}`,old);
      }
    }
    // Only undo the affected memberships. Later additions by other sessions remain intact.
    for(const id of affected){
      const session=ctx.state.sessions.find(s=>s.id===id);
      const existing=ctx.state.cards.find(c=>c.id===session?.cardId)?.members.find(m=>m.sessionId===id);
      for(const card of ctx.state.cards)card.members=card.members.filter(m=>m.sessionId!==id);
      if(!session?.cardId)continue;
      const target=ctx.state.cards.find(c=>c.id===session.cardId&&!c.deleted&&c.projectId===session.projectId);
      if(!target)throw new Error('无法撤销成员变更：目标卡片不存在或项目不一致');
      const old=previousMembers.get(`${target.id}:${id}`)??existing;
      const role=target.members.some(m=>m.role==='主会话')?'协作会话':old?.role??'主会话';
      target.members.push({sessionId:id,projectId:session.projectId,name:session.name,role,status:session.status,joinedAt:old?.joinedAt??ctx.at});
    }
  }
  private report(ctx:Context):void {
    const {event:e}=ctx,p=e.payload;
    if(e.actor.kind!=='session')throw new Error('报告必须来自会话');
    const session=this.getSession(ctx),cardId=session.turn?.cardId??session.cardId;
    if(!cardId)throw new Error('会话尚未绑定，请先绑定卡片');
    if(e.cardId&&e.cardId!==cardId)throw new Error('报告目标必须为本轮绑定卡片');
    const c=this.getCard(ctx,cardId);
    const patch=p.fields===undefined?{}:object(p.fields,'报告字段');
    for(const [field,value]of Object.entries(patch))this.validateField(field,value);
    if(p.operations!==undefined&&!Array.isArray(p.operations))throw new Error('报告操作须为数组');
    if(p.noChange!==undefined&&typeof p.noChange!=='boolean')throw new Error('无变化标记须为布尔值');
    if(p.noChange===true&&(Object.keys(patch).length||(p.operations as unknown[]|undefined)?.length))throw new Error('无变化报告不能同时修改内容');
    // Resolve blockers and add evidence before assessing the requested status.
    for(const value of (p.operations as unknown[]|undefined)??[]){
      const op=object(value,'报告操作');
      const allowed=['checklist.add','checklist.update','checklist.delete','checklist.check','acceptance.evidence','acceptance.reject','blocker.resolve','artifact.add','artifact.delete','card.archive','card.delete','session.unbind'];
      if(!allowed.includes(String(op.type))){ctx.warnings.push(`${String(op.type)} 已忽略：报告不允许此操作`);continue;}
      const before=clone(ctx.state);
      try { const sub={...ctx,event:{...e,type:op.type as Event['type'],cardId,payload:object(op.payload,'操作数据')}};this.mutate(sub); }
      catch(error){ctx.state=before;ctx.warnings.push(`已忽略：${error instanceof Error?error.message:String(error)}`);}
    }
    // A rejected sub-operation restores a snapshot, so reacquire card and session references.
    const current=ctx.state.cards.find(card=>card.id===cardId)!;
    this.updateFields(ctx,current,patch,typeof p.reason==='string'?p.reason:undefined,objectOrEmpty(p.reasons));
    const active=ctx.state.sessions.find(s=>s.id===session.id)!;if(active.turn)active.turn.reported=true;
    current.needsSync=false;
    if(p.noChange===true)ctx.summary.push('无变化');else ctx.summary.push('进展报告');
  }
  private instruction(ctx:Context):void {
    const {event:e}=ctx,p=e.payload;
    if(e.actor.kind!=='user_instruction')throw new Error('确认指令必须标记为用户对话指令');
    const session=this.getSession(ctx),prompt=this.prompts.get(session.id);
    if(!session.turn||session.status!=='运行中'||!e.turnId||session.turn.id!==e.turnId||!prompt||prompt.turnId!==e.turnId)throw new Error('原话核对失败：缺少当前轮用户消息');
    const quote=text(p.quote,'原话');
    if(!prompt.text.includes(quote))throw new Error('原话核对失败');
    // Approval uses a complete positive command, never a keyword or a fragment from negated/future/quoted prose.
    // A conservative refusal can be clarified; a false approval cannot safely be undone by the agent.
    const command=normalizeCommand(quote);
    if(normalizeCommand(prompt.text)!==command)throw new Error('原话未明确授权：请单独明确确认动作');
    const c=this.getCard(ctx,e.cardId??session.cardId);
    for(const match of quote.matchAll(/(?:#\s*(\d+)|(\d+)\s*号卡)/g))if(Number(match[1]??match[2])!==c.no)throw new Error('只能操作当前绑定卡片，请到目标卡片的会话或侧栏操作');
    ctx.approved=true;
    if(p.action==='complete'){
      if(!/^(?:请|现在请|现在|帮我|请帮我)?(?:把|将)?(?:这个|这张卡片?|当前卡片|本卡|#\d+|\d+号卡|卡片#\d+)?(?:确认完成|算完成了|(?:标记为|标为|设为|设置为)已?完成|已完成|完成通过)$/.test(command))throw new Error('原话未明确要求确认完成');
      this.setField(ctx,c,'status','已完成','按用户原话确认完成');ctx.summary.push('按指令确认完成，可撤销');return;
    }
    if(p.action!=='accept'&&p.action!=='reject')throw new Error('对话指令类型无效');
    const requested=strings(p.itemIds,'验收项 ID');if(!requested.length)throw new Error('须明确验收项');
    // Accept an explicit keep clause without treating it as permission to change that item.
    const keep=/(?:，|,|；|;)(第\d+项(?:[、和与]第\d+项)*)保持(?:不变)?$/.exec(command);
    const actionCommand=keep?command.slice(0,keep.index):command;
    if(keep)for(const match of keep[1]!.matchAll(/第(\d+)项/g)){
      const kept=c.acceptance[Number(match[1])-1];
      if(!kept||requested.includes(kept.id))throw new Error('原话要求保持的验收项不能修改');
    }
    const operation=p.action==='accept'?'(?:验收通过|通过验收|验收合格)':'(?:不认可|证据不认可|验收不通过)';
    const names=c.acceptance.map(item=>escapeRegex(normalizeCommand(item.content))).join('|');
    const selector=`(?:第\\d+项(?:[、和与]第\\d+项)*${names?`|${names}`:''})`;
    if(!new RegExp(`^(?:请)?${selector}${operation}$`).test(actionCommand))throw new Error('原话未明确授权验收范围或动作');
    const selected=actionCommand.replace(/^请/,'').replace(new RegExp(`${operation}$`),'');
    let permitted:Set<string>;
    if(/^第\d+项(?:[、和与]第\d+项)*$/.test(selected)){
      const mentioned=[...selected.matchAll(/第(\d+)项/g)].map(match=>c.acceptance[Number(match[1])-1]?.id);
      if(mentioned.some(id=>!id))throw new Error('原话引用的验收项不存在');
      permitted=new Set(mentioned as string[]);
    }else{
      const byName=c.acceptance.filter(item=>normalizeCommand(item.content)===selected);
      if(byName.length!==1)throw new Error('验收项名称有歧义，请使用明确序号');
      permitted=new Set([byName[0]!.id]);
    }
    if(!permitted.size||requested.some(id=>!permitted.has(id)))throw new Error('超出原话明确范围，整次拒绝');
    for(const id of requested){const item=c.acceptance.find(item=>item.id===id);if(!item)throw new Error('验收项不存在');this.setItemField(ctx,c,'acceptance',item,'checked',p.action==='accept');if(p.action==='reject')this.setItemField(ctx,c,'acceptance',item,'rejected',true);}
    ctx.summary.push('按指令更新验收，可撤销');
  }
  private notify(ctx:Context,c:Card,key:string,type:Notification['type'],targetId?:string,sessionId?:string):void {
    const fullKey=`${c.id}:${key}`,existing=ctx.state.notifications.find(n=>n.key===fullKey&&n.active);
    if(existing){existing.type=type;return;}
    ctx.state.notifications.push({id:randomUUID(),key:fullKey,projectId:c.projectId,cardId:c.id,type,targetId,sessionId,status:'待处理',active:true,createdAt:ctx.at});
  }
  private derive(ctx:Context):void {
    for(const c of ctx.state.cards){
      for(const list of [c.checklist,c.acceptance,c.blockers])for(const item of list)item.acceptanceState=item.checked?'已验收':item.evidence.length&&!item.rejected?'待确认':'未验收';
      const accepted=c.acceptance.filter(i=>i.checked).length,pending=c.acceptance.filter(i=>i.acceptanceState==='待确认').length,total=c.acceptance.length;
      c.progress=total?{accepted,pending,total,label:`${accepted}/${total} 已验收${pending?` · ${pending} 待确认`:''}`}:null;
      for(const member of c.members){const session=ctx.state.sessions.find(s=>s.id===member.sessionId);if(session){member.status=session.status;member.name=session.name;}}
      c.flags=[];
      if(c.blockers.some(item=>item.blocking&&!item.checked))c.flags.push('阻塞');
      if(c.needsSync)c.flags.push('待补同步');
      if(c.members.some(m=>m.role==='主会话'&&['已归档','找不到'].includes(m.status)))c.flags.push('主会话不可用');
      if(c.conflicts.some(conflict=>!conflict.resolved))c.flags.push('有冲突');
      const activeKeys=new Set<string>();
      const want=(key:string,type:Notification['type'],targetId?:string,sessionId?:string)=>{activeKeys.add(`${c.id}:${key}`);this.notify(ctx,c,key,type,targetId,sessionId);};
      if(!c.deleted&&!c.archived){
        for(const item of c.blockers)if(!item.checked)want(`blocker:${item.id}`,item.waitingFor==='外部'?'卡点（等外部，需我跟进）':'卡点（等我处理）',item.id,item.source.kind==='session'?item.source.id:undefined);
        if(c.status==='待验收')want('review','卡片待验收');
        for(const conflict of c.conflicts)if(!conflict.resolved)want(`conflict:${conflict.id}`,'冲突',conflict.id);
        for(const member of c.members)if(member.role==='主会话'&&['已归档','找不到'].includes(member.status))want(`unavailable:${member.sessionId}`,'主会话不可用',member.sessionId,member.sessionId);
      }
      for(const n of ctx.state.notifications){
        if(n.cardId!==c.id||!n.active)continue;
        const lifecycle=['卡点（等我处理）','卡点（等外部，需我跟进）','卡片待验收','冲突','主会话不可用'].includes(n.type);
        if((lifecycle&&!activeKeys.has(n.key))||(n.type==='已完成的卡片被会话重新打开'&&c.status==='已完成')||c.deleted||c.archived){n.active=false;n.status='已处理';n.resolvedAt=ctx.at;}
      }
    }
  }
  completionPreview(cardId:string):CompletionPreview {
    const c=this.getState().cards.find(c=>c.id===cardId&&!c.deleted);if(!c)throw new Error('卡片不存在');
    return {cardId,unaccepted:c.acceptance.filter(i=>!i.checked),unresolvedBlockers:c.blockers.filter(i=>!i.checked),conflicts:c.conflicts.filter(c=>!c.resolved)};
  }
  query(options:QueryOptions={}):QueryResult {
    const state=this.getState();
    const ids=options.projectIds??(options.currentProjectId?[options.currentProjectId]:'all');
    const matchesProject=(projectId:string)=>ids==='all'||ids.includes(projectId);
    const now=new Date(`${businessDate(options.now??new Date())}T12:00:00Z`),start=new Date(now);
    start.setUTCDate(now.getUTCDate()-((now.getUTCDay()+6)%7));const end=new Date(start);end.setUTCDate(end.getUTCDate()+6);
    const weekStart=start.toISOString().slice(0,10),weekEnd=end.toISOString().slice(0,10);
    let cards=state.cards.filter(c=>!c.deleted&&(options.includeArchived||!c.archived)&&matchesProject(c.projectId));
    if(options.view==='进行中')cards=cards.filter(c=>c.status==='进行中');
    if(options.view==='本周到期')cards=cards.filter(c=>c.status!=='已完成'&&c.dueDate&&c.dueDate>=weekStart&&c.dueDate<=weekEnd);
    if(options.view==='今天需跟进'||options.view==='逾期事项'){const view=options.view;cards=cards.filter(c=>matchesFollowUpView(c,view,options.now));}
    for(const filter of options.filters??[]){cards=cards.filter(c=>{const value=filter.field==='hasBlockers'?c.blockers.some(i=>!i.checked):(c as unknown as Record<string,unknown>)[filter.field];switch(filter.condition){case'eq':return same(value,filter.value);case'in':return Array.isArray(filter.value)&&filter.value.includes(value);case'contains':return Array.isArray(value)?value.includes(filter.value):String(value??'').includes(String(filter.value));case'before':return value!==null&&String(value)<String(filter.value);case'after':return value!==null&&String(value)>String(filter.value);}});}
    const sort=options.sort??{field:'order',direction:'asc'};
    cards.sort((a,b)=>{const av=a[sort.field],bv=b[sort.field];const cmp=sort.field==='followUpAt'&&typeof av==='string'&&typeof bv==='string'?Date.parse(av)-Date.parse(bv):sort.field==='priority'?['高','中','低'].indexOf(String(av))-['高','中','低'].indexOf(String(bv)):typeof av==='number'&&typeof bv==='number'?av-bv:String(av??'').localeCompare(String(bv??''));return cmp*(sort.direction==='desc'?-1:1);});
    const mapped=cards.map(c=>({ ...c, projectName:state.projects.find(p=>p.id===c.projectId)?.name??c.projectId,displayName:`${state.projects.find(p=>p.id===c.projectId)?.name??c.projectId} · #${c.no}` }));
    const notifications=state.notifications.filter(n=>n.status==='待处理'&&matchesProject(n.projectId)).map(n=>({...n,projectName:state.projects.find(p=>p.id===n.projectId)?.name??n.projectId}));
    const grouped=new Map<string,string[]>();if(options.groupBy)for(const c of cards){const key=String(c[options.groupBy]);grouped.set(key,[...(grouped.get(key)??[]),c.id]);}
    return {cards:mapped,notifications,groups:[...grouped].map(([key,cardIds])=>({key,count:cardIds.length,cardIds}))};
  }
  backup(path:string):void {
    if(this.dbPath!==':memory:'&&resolve(path)===resolve(this.dbPath))throw new Error('备份不能覆盖当前数据库');
    mkdirSync(dirname(resolve(path)),{recursive:true,mode:0o700});
    // VACUUM INTO creates one transactionally consistent SQLite snapshot, including WAL contents.
    // Reserve an empty private file atomically, before SQLite writes any database bytes.
    const fd=openSync(path,'wx',0o600);closeSync(fd);
    try{this.db.prepare('VACUUM INTO ?').run(path);}catch(error){unlinkSync(path);throw error;}
  }
  restore(path:string):void {
    const result=this.applyEvent({id:randomUUID(),type:'store.restore',actor:{kind:'user'},payload:{path}});
    if(!result.ok)throw new Error(result.errors.join('；'));
  }
  private restoreSnapshot(path:string):void {
    if(this.dbPath!==':memory:'&&resolve(path)===resolve(this.dbPath))throw new Error('恢复来源不能是当前数据库');
    const source=new DatabaseSync(path,{readOnly:true});
    try{
      const integrity=source.prepare('PRAGMA integrity_check').get() as {integrity_check:string};if(integrity.integrity_check!=='ok')throw new Error('备份数据库不完整');
      const snapshot=source.prepare('SELECT json FROM snapshot WHERE id=1').get() as {json:string}|undefined;if(!snapshot)throw new Error('备份不包含项目数据');
      const data=JSON.parse(snapshot.json) as State;if(data.schemaVersion!==1)throw new Error('不支持此备份版本');
      const rows=source.prepare('SELECT seq,event_id,report_key,json,result FROM activities ORDER BY seq').all() as {seq:number,event_id:string,report_key:string|null,json:string,result:string}[];
      const replay=ProjectStore.replay(rows.map(row=>JSON.parse(row.json) as Activity));if(!same({...replay,activities:[]},normalizePlanningFields(data)))throw new Error('备份活动与快照不一致');
      // A restore reinstates the backed-up activity stream exactly (C-242). It enters applyEvent,
      // but appending a new domain activity here would no longer be a point-in-time restoration.
      this.db.exec('DELETE FROM activities');
      const insert=this.db.prepare('INSERT INTO activities(seq,event_id,report_key,json,result) VALUES(?,?,?,?,?)');
      for(const row of rows)insert.run(row.seq,row.event_id,row.report_key,row.json,row.result);
      this.db.prepare('UPDATE snapshot SET json=? WHERE id=1').run(snapshot.json);
      // Receipt metadata survives restoration and is excluded from the business snapshot.
      if(source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_events'").get()){
        const receipts=source.prepare('SELECT event_id,result FROM maintenance_events').all() as {event_id:string,result:string}[];
        const receiptInsert=this.db.prepare('INSERT OR IGNORE INTO maintenance_events(event_id,result) VALUES(?,?)');
        for(const row of receipts)receiptInsert.run(row.event_id,row.result);
      }
    }finally{source.close();}
  }
  static replay(activities:Activity[]):State {
    const state=empty();for(const activity of activities){for(const change of activity.changes)applyChange(state,change);normalizePlanningFields(state);state.revision=activity.revision;state.updatedAt=activity.at;state.activities.push(clone(activity));}return state;
  }
}

/** Read compatibility only: never guess the owner of an existing card or rewrite its history. */
function normalizePlanningFields(state:State):State {
  for(const card of state.cards){
    if(!Object.hasOwn(card,'followUpOwner'))card.followUpOwner='';
    if(!Object.hasOwn(card,'followUpAt'))card.followUpAt=null;
  }
  return state;
}

function objectOrEmpty(v:unknown):Record<string,unknown>{return v===undefined?{}:object(v,'逐字段原因');}
function canonicalValue(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonicalValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonicalValue(item)]));
  return value;
}
function normalizeCommand(value:string):string{return value.trim().replace(/[\s]/g,'').replace(/[。！!]$/,'');}
function escapeRegex(value:string):string{return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
/** Reverse only this activity's array delta; preserve independent later additions. */
function undoArrayDelta(current:unknown[],before:unknown[],after:unknown[]):unknown[]{
  const result=clone(current);
  const identity=(value:unknown)=>value&&typeof value==='object'&&'id' in value?String((value as {id:unknown}).id):JSON.stringify(value);
  const beforeKeys=before.map(identity),afterKeys=after.map(identity);
  for(let i=after.length-1;i>=0;i--){
    const key=afterKeys[i]!,oldIndex=beforeKeys.indexOf(key),index=result.findIndex(value=>identity(value)===key);
    if(oldIndex<0){if(index>=0)result.splice(index,1);continue;}
    if(index<0)continue;
    const old=before[oldIndex],next=after[i];if(same(old,next))continue;
    const value=result[index] as Record<string,unknown>,a=old as Record<string,unknown>,b=next as Record<string,unknown>;
    for(const field of new Set([...Object.keys(a),...Object.keys(b)])){
      if(same(a[field],b[field])||field==='acceptanceState')continue;
      if(Array.isArray(a[field])&&Array.isArray(b[field])&&Array.isArray(value[field]))value[field]=undoArrayDelta(value[field] as unknown[],a[field],b[field]);
      else if(!Object.hasOwn(a,field))delete value[field];else value[field]=clone(a[field]);
    }
  }
  for(let i=0;i<before.length;i++)if(!afterKeys.includes(beforeKeys[i]!)&&!result.some(value=>identity(value)===beforeKeys[i]))result.splice(Math.min(i,result.length),0,clone(before[i]));
  return result;
}
function diff(before:State,after:State):Change[]{
  const changes:Change[]=[];
  for(const collection of ['projects','cards','sessions','notifications'] as const){
    const prev=before[collection] as unknown as {id:string;[key:string]:unknown}[],next=after[collection] as unknown as {id:string;[key:string]:unknown}[];
    for(const id of new Set([...prev.map(v=>v.id),...next.map(v=>v.id)])){
      const a=prev.find(v=>v.id===id),b=next.find(v=>v.id===id);
      if(!a||!b){changes.push({collection,id,before:a??null,after:b??null});continue;}
      for(const field of new Set([...Object.keys(a),...Object.keys(b)]))if(!same(a[field],b[field]))changes.push({collection,id,field,before:a[field]??null,after:b[field]??null,beforeExists:Object.hasOwn(a,field),afterExists:Object.hasOwn(b,field),...(collection==='cards'&&(b.fieldRevisions as Card['fieldRevisions'])?.[field]?.reason?{reason:(b.fieldRevisions as Card['fieldRevisions'])[field]!.reason}:{})});
    }
  }
  for(const key of new Set([...Object.keys(before.preferences),...Object.keys(after.preferences)]))if(!same(before.preferences[key],after.preferences[key]))changes.push({collection:'preferences',id:key,before:before.preferences[key]??null,after:after.preferences[key]??null,beforeExists:Object.hasOwn(before.preferences,key),afterExists:Object.hasOwn(after.preferences,key)});
  return changes;
}
function applyChange(state:State,change:Change):void {
  if(change.collection==='preferences'){if(change.afterExists===false)delete state.preferences[change.id];else state.preferences[change.id]=clone(change.after);return;}
  const list=state[change.collection] as unknown as {id:string;[key:string]:unknown}[];
  const index=list.findIndex(row=>row.id===change.id);
  if(!change.field){if(change.after===null){if(index>=0)list.splice(index,1);}else if(index<0)list.push(clone(change.after) as {id:string});else list[index]=clone(change.after) as {id:string};return;}
  if(index<0)throw new Error('活动重放引用不存在的实体');
  if(change.afterExists===false)delete list[index]![change.field];else list[index]![change.field]=clone(change.after);
}
