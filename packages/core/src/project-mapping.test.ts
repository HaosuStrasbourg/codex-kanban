import { afterEach, expect, it } from 'vitest';
import { ProjectStore } from './index.ts';
import type { Actor } from './types.ts';

const stores: ProjectStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new ProjectStore(':memory:'); stores.push(store);
  let seq = 0;
  const upsert = (payload: Record<string, unknown>, actor: Actor = { kind: 'user' }) => store.applyEvent({
    id: `mapping-${++seq}`, type: 'project.upsert', actor, payload: { id: 'p', name: '同名项目', folder: '/synthetic/project', ...payload },
  });
  const project = () => store.getState().projects[0]!;
  return { store, upsert, project };
}

it('C-001 用户显式保存hostProjectId，按字段记录活动且重放一致（核心映射回归）', () => {
  const x = fixture(); expect(x.upsert({ hostProjectId: 'host-project-1' }).ok).toBe(true);
  expect(x.project().hostProjectId).toBe('host-project-1');
  expect(x.upsert({ hostProjectId: 'host-project-2' }).ok).toBe(true);
  expect(x.project().hostProjectId).toBe('host-project-2');
  expect(x.store.getState().activities.at(-1)?.changes).toContainEqual(expect.objectContaining({
    collection: 'projects', field: 'hostProjectId', before: 'host-project-1', after: 'host-project-2',
  }));
  expect(ProjectStore.replay(x.store.getState().activities)).toEqual(x.store.getState());
});

it.each<Actor>([{ kind: 'user' }, { kind: 'system' }])('C-001 不带映射且目录未变的普通更新保留显式映射：%j（核心映射回归）', actor => {
  const x = fixture(); x.upsert({ hostProjectId: 'host-project-1' });
  expect(x.upsert({ name: '项目新名称' }, actor).ok).toBe(true);
  expect(x.project()).toMatchObject({ name: '项目新名称', folder: '/synthetic/project', hostProjectId: 'host-project-1' });
});

it.each(['replacement', '', null, undefined])('C-001 system不得指定或清除用户映射：%j（核心映射回归）', hostProjectId => {
  const x = fixture(); x.upsert({ hostProjectId: 'host-project-1' }); const before = x.project();
  expect(x.upsert({ name: '不得顺带生效', hostProjectId }, { kind: 'system' }).ok).toBe(false);
  expect(x.project()).toEqual(before);
});

it('C-001 system不能自行建立映射（核心映射回归）', () => {
  const x = fixture(); expect(x.upsert({ hostProjectId: 'guessed' }, { kind: 'system' }).ok).toBe(false);
  expect(x.store.getState().projects).toHaveLength(0);
});

it('C-650 system只可登记新的canonical自身映射，不能改映射或占用既有本地ID', () => {
  const x = fixture();
  expect(x.upsert({ id: 'official-P', hostProjectId: 'official-P' }, { kind: 'system' }).ok).toBe(true);
  expect(x.project()).toMatchObject({ id: 'official-P', hostProjectId: 'official-P' });
  expect(x.store.getState().activities[0]?.actor.kind).toBe('system');
  expect(ProjectStore.replay(x.store.getState().activities)).toEqual(x.store.getState());
  expect(x.upsert({ id: 'official-P', hostProjectId: 'official-Q' }, { kind: 'system' }).ok).toBe(false);
  const local = fixture(); expect(local.upsert({}).ok).toBe(true);
  expect(local.upsert({ hostProjectId: 'p' }, { kind: 'system' }).ok).toBe(false);
  expect(local.project().hostProjectId).toBeUndefined();
});

it.each(['', '   ', null, undefined, 123, 'h'.repeat(241)])('C-001 hostProjectId必须非空字符串且不超过240字符：%j（核心映射回归）', hostProjectId => {
  const x = fixture(); expect(x.upsert({ hostProjectId }).ok).toBe(false);
  expect(x.store.getState().projects).toHaveLength(0);
});

it('C-001 用户改目录未重新选择hostProjectId时清除旧映射（核心映射回归）', () => {
  const x = fixture(); x.upsert({ hostProjectId: 'host-project-1' });
  expect(x.upsert({ folder: '/synthetic/other' }).ok).toBe(true);
  expect(x.project().folder).toBe('/synthetic/other'); expect(x.project().hostProjectId).toBeUndefined();
  expect(ProjectStore.replay(x.store.getState().activities)).toEqual(x.store.getState());
});

it('C-001 用户同时更换目录和显式映射时保存新选择（核心映射回归）', () => {
  const x = fixture(); x.upsert({ hostProjectId: 'host-project-1' });
  expect(x.upsert({ folder: '/synthetic/other', hostProjectId: 'host-project-2' }).ok).toBe(true);
  expect(x.project()).toMatchObject({ folder: '/synthetic/other', hostProjectId: 'host-project-2' });
});

it('C-001 system不得通过改目录使用户映射失效（核心映射回归）', () => {
  const x = fixture(); x.upsert({ hostProjectId: 'host-project-1' }); const before = x.project();
  expect(x.upsert({ folder: '/synthetic/other' }, { kind: 'system' }).ok).toBe(false);
  expect(x.project()).toEqual(before);
});
