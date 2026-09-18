import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { generateKeyBetween } from 'fractional-indexing'
import { db } from './db'
import { pages, profiles, workspaceMembers, workspaces } from './schema'
import { InvalidInput, NotFound } from './errors'
import { assertWorkspaceAdmin, assertWorkspaceMember } from './permissions'
import * as audit from './audit'
import type { Actor } from './actor'
import type { WorkspaceRole } from './permissions'

/** 로그인 직후 호출. auth.users 와 profiles 를 맞춘다. */
export async function ensureProfile(input: {
  id: string
  email: string
  displayName?: string | null
  avatarUrl?: string | null
}) {
  await db.insert(profiles).values({
    id: input.id,
    email: input.email,
    displayName: input.displayName || input.email.split('@')[0],
    avatarUrl: input.avatarUrl ?? null,
  }).onConflictDoUpdate({
    target: profiles.id,
    set: { email: input.email, avatarUrl: input.avatarUrl ?? null },
  })
}

export type MyWorkspace = {
  id: string
  name: string
  role: WorkspaceRole
  memberCount: number
}

/**
 * 내가 속한 프로젝트 룸 전부. 사이드바 드롭다운과 세션의 활성 룸 선택이 함께 쓴다.
 *
 * ★ 정렬 기준이 중요하다.
 *   createdAt 오름차순으로만 하면, 예전 버그로 각자 만들어진 1인 룸이
 *   나중에 초대로 참여한 팀 룸보다 앞서버린다. 멤버가 많은 쪽(= 실제 팀)을
 *   먼저 놓고, 동수면 오래된 쪽을 먼저 놓는다. 그래서 **첫 항목이 곧 기본 룸**이다.
 */
export async function getMyWorkspaces(userId: string): Promise<MyWorkspace[]> {
  const rows = await db.execute(sql`
    SELECT w.id, w.name, m.role,
           (SELECT count(*) FROM workspace_members m2 WHERE m2.workspace_id = w.id) AS member_count
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ${userId}
     ORDER BY member_count DESC, w.created_at ASC
  `)
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    role: r.role as WorkspaceRole,
    memberCount: Number(r.member_count),
  }))
}

/**
 * 프로젝트 룸 이름 변경. **admin 이상만** 할 수 있다.
 * 빈 이름은 사이드바에서 아무것도 못 누르는 상태를 만들므로 막는다.
 */
export async function renameWorkspace(
  actor: Actor,
  workspaceId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  await assertWorkspaceAdmin(actor.userId, workspaceId)

  const trimmed = name.trim()
  if (!trimmed) throw new InvalidInput('룸 이름을 입력해 주세요')
  if (trimmed.length > 60) throw new InvalidInput('룸 이름은 60자까지입니다')

  const [row] = await db.update(workspaces)
    .set({ name: trimmed })
    .where(eq(workspaces.id, workspaceId))
    .returning({ id: workspaces.id, name: workspaces.name })
  if (!row) throw new NotFound('Workspace')

  await audit.record(actor, 'workspace.rename', {
    workspaceId, targetId: workspaceId, meta: { name: trimmed },
  })
  return row
}

/** 워크스페이스 + owner 멤버십 + 첫 페이지를 한 트랜잭션으로 만든다. */
export async function createWorkspace(actor: Actor, name: string) {
  const result = await db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces)
      .values({ name, ownerId: actor.userId })
      .returning()

    await tx.insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: actor.userId, role: 'owner' })

    const [home] = await tx.insert(pages).values({
      workspaceId: ws.id,
      parentId: null,
      path: '/',
      sortKey: generateKeyBetween(null, null),
      title: '시작하기',
      icon: { type: 'emoji', value: '👋' },
      createdBy: actor.userId,
      lastEditedBy: actor.userId,
    }).returning()

    return { workspace: ws, homePageId: home.id }
  })

  await audit.record(actor, 'workspace.create', {
    workspaceId: result.workspace.id, targetId: result.workspace.id, meta: { name },
  })
  return result
}

/**
 * 기본 프로젝트 룸 (활성 룸이 지정되지 않았을 때 보여줄 것).
 * 정렬 규칙은 getMyWorkspaces 한 곳에만 둔다 — 첫 항목이 기본이다.
 */
export async function getPrimaryWorkspace(userId: string) {
  const [first] = await getMyWorkspaces(userId)
  return first ? { id: first.id, name: first.name } : null
}

/**
 * 아직 워크스페이스가 하나도 없는 새 인스턴스인지.
 * "첫 사용자만 자동 생성" 규칙의 판단 근거다.
 */
export async function isFirstRun(): Promise<boolean> {
  const [row] = await db.select({ id: workspaces.id }).from(workspaces).limit(1)
  return !row
}

/**
 * 로그인 시 워크스페이스 확보.
 *
 * ⚠️ 예전에는 "내 워크스페이스가 없으면 새로 만든다" 였다.
 * 그 결과 팀원이 Google 로 그냥 로그인할 때마다 각자 1인 워크스페이스가
 * 생겨서 아무도 같은 위키를 못 봤다.
 *
 * 이제는 **아무도 워크스페이스를 안 가진 최초 1회에만** 만든다.
 * 그 뒤에 들어오는 사람은 초대를 통해서만 합류한다.
 */
export async function ensureWorkspaceOnLogin(actor: Actor) {
  const mine = await getMyWorkspaces(actor.userId)
  if (mine.length > 0) return { id: mine[0].id, name: mine[0].name }

  if (await isFirstRun()) {
    const { workspace } = await createWorkspace(actor, '우리 팀')
    return { id: workspace.id, name: workspace.name }
  }

  // 초대받지 못한 사용자 — 대기 화면을 보여준다
  return null
}

/** @멘션 / 담당자 지정 / MCP list_members 용 */
export async function listMembers(actor: Actor, workspaceId: string) {
  await assertWorkspaceMember(actor.userId, workspaceId)
  return db
    .select({
      id: profiles.id,
      email: profiles.email,
      displayName: profiles.displayName,
      avatarUrl: profiles.avatarUrl,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(profiles, eq(profiles.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(profiles.displayName))
}

/**
 * 워크스페이스의 첫 최상위 페이지 id.
 * 로그인 직후 "/" 를 거치지 않고 바로 그 페이지로 보내기 위한 것이다
 * ("/" 는 레이아웃(트리 조회)까지 렌더한 뒤 리다이렉트해서 왕복이 낭비된다).
 */
export async function getFirstPageId(workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(
      eq(pages.workspaceId, workspaceId),
      isNull(pages.parentId),
      eq(pages.isTrashed, false),
      isNull(pages.collectionId),
    ))
    .orderBy(asc(pages.sortKey))
    .limit(1)
  return row?.id ?? null
}

export async function getWorkspace(actor: Actor, workspaceId: string) {
  await assertWorkspaceMember(actor.userId, workspaceId)
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!ws) throw new NotFound('Workspace')
  return ws
}
