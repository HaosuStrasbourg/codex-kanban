import { afterEach, expect, test } from 'vitest';
import { ProjectStore } from './index.ts';

const stores: ProjectStore[] = [];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function fixture() {
  const store = new ProjectStore(':memory:',{clock:()=> '2026-10-05T13:00:00.000Z'}); stores.push(store);
  store.applyEvent({id:'project',type:'project.upsert',actor:{kind:'system'},payload:{id:'P',name:'合成项目',folder:'/synthetic'}});
  let sequence = 0;
  const upsert = (payload:Record<string,unknown>) => store.applyEvent({id:`metadata-${++sequence}`,type:'session.upsert',actor:{kind:'system'},payload:{id:'S',projectId:'P',name:'合成会话',...payload}});
  return {store,upsert};
}

test('C-317 session.upsert显式lastActivityAt保存历史时间，活动时间仍为本次登记时间且可重放',()=>{
  const x=fixture(); expect(x.upsert({lastActivityAt:'2025-01-02T03:04:05.000Z'}).ok).toBe(true);
  expect(x.store.getState().sessions[0]?.lastActivityAt).toBe('2025-01-02T03:04:05.000Z');
  expect(x.store.getState().activities.at(-1)?.at).toBe('2026-10-05T13:00:00.000Z');
  expect(ProjectStore.replay(x.store.getState().activities)).toEqual(x.store.getState());
});

test.each(['not-a-time','2026-02-30T00:00:00.000Z','2026-10-05',null,undefined,123])('C-317 显式无效lastActivityAt拒绝且不改会话：%j',lastActivityAt=>{
  const x=fixture(); x.upsert({}); const before=x.store.getState().sessions;
  expect(x.upsert({name:'不应更名',lastActivityAt}).ok).toBe(false);
  expect(x.store.getState().sessions).toEqual(before);
});

test('C-318 session.upsert保留更晚活动时间，省略字段保持事件时间默认行为',()=>{
  const x=fixture(); x.upsert({lastActivityAt:'2025-01-02T03:04:05.000Z'});
  x.upsert({lastActivityAt:'2024-01-02T03:04:05.000Z'});
  expect(x.store.getState().sessions[0]?.lastActivityAt).toBe('2025-01-02T03:04:05.000Z');
  x.upsert({});
  expect(x.store.getState().sessions[0]?.lastActivityAt).toBe('2026-10-05T13:00:00.000Z');
});
