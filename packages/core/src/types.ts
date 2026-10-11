/** Local domain contract. Transport adapters must authenticate actor and session identity. */
export type Status = '未开始' | '计划中' | '进行中' | '待验收' | '已完成' | '暂停';
export type Priority = '高' | '中' | '低';
export type Actor = { kind: 'user' | 'assistant' | 'session' | 'user_instruction' | 'system'; id?: string; name?: string };
export type Evidence = { kind: 'document' | 'command' | 'conversation'; reference: string; detail: string };
export interface Project { id: string; name: string; folder: string; nextNo: number; hostProjectId?: string }
export interface ChecklistItem {
  id: string; content: string; checked: boolean; source: Actor; reason?: string;
  evidence: Evidence[]; rejected: boolean; acceptanceState: '未验收' | '待确认' | '已验收';
  blocking?: boolean; waitingFor?: '我' | '外部'; resolution?: string;
}
export interface Member { sessionId: string; projectId: string; name: string; role: '主会话' | '协作会话'; status: '运行中' | '空闲' | '已归档' | '找不到'; joinedAt: string }
export interface Artifact { id: string; title: string; link: string; source: Actor; at: string }
export interface FieldRevision { revision: number; actor: Actor; reason?: string }
export interface Conflict { id: string; field: string; current: unknown; proposed: unknown; currentSource: Actor; proposedSource: Actor; currentReason?: string; proposedReason?: string; resolved: boolean }
export interface Card {
  id: string; projectId: string; no: number; title: string; description: string; tags: string[];
  priority: Priority; dueDate: string | null; followUpOwner: string; followUpAt: string | null; status: Status; progressText: string; nextStep: string;
  archived: boolean; deleted: boolean; order: number; createdAt: string; updatedAt: string;
  checklist: ChecklistItem[]; acceptance: ChecklistItem[]; blockers: ChecklistItem[];
  members: Member[]; artifacts: Artifact[]; conflicts: Conflict[];
  flags: string[]; progress: { accepted: number; pending: number; total: number; label: string } | null;
  fieldRevisions: Record<string, FieldRevision>; needsSync: boolean; sessionCreationError?: string;
}
export interface Session {
  id: string; projectId: string; name: string; status: Member['status']; cardId?: string;
  pendingCardId?: string; bindingChanged?: boolean; lastActivityAt: string;
  turn?: { id: string; number: number; baseRevision: number; cardId?: string; reported: boolean };
}
export interface Notification { id: string; key: string; projectId: string; cardId: string; type: '卡点（等我处理）' | '卡点（等外部，需我跟进）' | '卡片待验收' | '冲突' | '主会话不可用' | '已完成的卡片被会话重新打开' | '同步失败'; targetId?: string; sessionId?: string; status: '待处理' | '已处理'; active: boolean; createdAt: string; resolvedAt?: string }
export interface Change { collection: 'projects' | 'cards' | 'sessions' | 'notifications' | 'preferences'; id: string; field?: string; before: unknown; after: unknown; reason?: string; beforeExists?: boolean; afterExists?: boolean }
export interface Activity {
  id: string; eventId: string; revision: number; cardId?: string; projectId?: string; sessionId?: string; turnId?: string;
  at: string; actor: Actor; type: EventType; result: '已生效' | '部分生效' | '已退回';
  /** Content fingerprint distinguishes an unchanged rejected retry from a corrected report. */
  requestDigest?: string;
  summary: string; warnings: string[]; errors: string[]; changes: Change[]; quote?: string; reason?: string; collapsed: boolean;
}
export interface State { schemaVersion: 1; revision: number; updatedAt: string | null; projects: Project[]; cards: Card[]; sessions: Session[]; activities: Activity[]; notifications: Notification[]; preferences: Record<string, unknown>; syncError?: { message: string; lastUpdatedAt: string | null } }
export type EventType = 'project.upsert' | 'card.create' | 'card.update' | 'card.archive' | 'card.delete' | 'card.complete' | 'card.reorder' | 'checklist.add' | 'checklist.update' | 'checklist.delete' | 'checklist.check' | 'acceptance.evidence' | 'acceptance.reject' | 'blocker.resolve' | 'artifact.add' | 'artifact.delete' | 'session.upsert' | 'session.bind' | 'session.unbind' | 'session.create_failed' | 'turn.start' | 'turn.end' | 'report.submit' | 'instruction.apply' | 'notification.resolve' | 'activity.undo' | 'comment.add' | 'preferences.update' | 'sync.missing' | 'sync.failed' | 'sync.recovered' | 'store.restore';
/**
 * Payloads:
 * project.upsert {id,name,folder,hostProjectId?} (mapping changes are user-only; system may register a new canonical id as itself);
 * session.upsert {id,projectId,name,status?,lastActivityAt?:string} (UTC ISO timestamp; omitted uses event time; supplied never replaces a later timestamp);
 * card.create {title,description?,priority?,dueDate?,followUpOwner?,followUpAt?,tags?,acceptance?:string[]};
 * card.update {fields:{title?,description?,tags?,priority?,dueDate?,followUpOwner?,followUpAt?,status?,progressText?,nextStep?},reason?};
 * followUpAt is null or a valid ISO timestamp with explicit timezone; new cards default followUpOwner='我', old missing values read as ''.
 * checklist.add/update/delete/check {list:'checklist'|'acceptance'|'blockers',itemId?,content?,checked?,blocking?,waitingFor?,reason?};
 * acceptance.evidence {itemId,evidence:Evidence}; acceptance.reject {itemId}; blocker.resolve {itemId,basis};
 * session.bind {cardNo?|cardId?,confirmed?:boolean,expectedCurrentCardId?:string}; cardId is also accepted on envelope;
 * turn.start {userMessage?,number?}; turn.end {interrupted?:boolean};
 * report.submit {reportId?,fields?,reason?,reasons?:Record<string,string>,noChange?,operations?:{type:EventType,payload:Record<string,unknown>}[]};
 * instruction.apply {quote,action:'complete'|'accept'|'reject',itemIds?:string[]};
 * activity.undo {activityId}; notification.resolve {notificationId}; preferences.update {key,value};
 * artifact.add {title,link}; artifact.delete {artifactId}; card.reorder {order};
 * card.complete needs actor=user; instruction.apply checks current captured turn before allowing completion/acceptance.
 * assistant may only create cards or bind sessions in its registered issuer's project; actor.id is the trusted issuer,
 * projectId is required, and sessionId is the issuer (or absent) for create and the target for bind.
 * assistant create accepts only the documented card.create fields; rebind requires exact expectedCurrentCardId, never confirmed.
 */
export interface Event { id: string; type: EventType; actor: Actor; projectId?: string; cardId?: string; sessionId?: string; turnId?: string; at?: string; payload: Record<string, unknown> }
export interface Result { ok: boolean; status: 'applied' | 'partial' | 'rejected' | 'duplicate' | 'failed' | 'confirmation_required'; activityId?: string; cardId?: string; errors: string[]; warnings: string[]; confirmation?: { fromCardId: string; toCardId: string } }
export interface Filter { field: 'status' | 'tags' | 'priority' | 'dueDate' | 'followUpOwner' | 'hasBlockers'; condition: 'eq' | 'in' | 'contains' | 'before' | 'after'; value: unknown }
export interface QueryOptions { projectIds?: string[] | 'all'; currentProjectId?: string; view?: '需要我处理' | '进行中' | '本周到期' | '今天需跟进' | '逾期事项' | '全部'; filters?: Filter[]; includeArchived?: boolean; now?: string; sort?: { field: 'order' | 'title' | 'dueDate' | 'followUpOwner' | 'followUpAt' | 'priority' | 'updatedAt'; direction: 'asc' | 'desc' }; groupBy?: 'projectId' | 'status' | 'priority' }
export interface QueryResult { cards: (Card & { projectName: string; displayName: string })[]; notifications: (Notification & { projectName: string })[]; groups: { key: string; count: number; cardIds: string[] }[] }
export interface CompletionPreview { cardId: string; unaccepted: ChecklistItem[]; unresolvedBlockers: ChecklistItem[]; conflicts: Conflict[] }
