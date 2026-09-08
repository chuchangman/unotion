import { and, asc, eq } from 'drizzle-orm'
import { generateKeyBetween } from 'fractional-indexing'
import { db } from './db'
import { pages, profiles, workspaceMembers, workspaces } from './schema'
import { NotFound } from './errors'
import { assertWorkspaceMember } from './permissions'
import * as audit from './audit'
import type { Actor } from './actor'

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

export async function getMyWorkspaces(userId: string) {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt))
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
 * 기본 워크스페이스를 **읽기만** 한다 (렌더 경로용).
 * 단일 쿼리 + limit 1 이라 왕복이 하나다.
 */
export async function getPrimaryWorkspace(userId: string) {
  const [row] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt))
    .limit(1)
  return row ?? null
}

/** 로그인 사용자의 기본 워크스페이스. 없으면 만든다. */
export async function getOrCreateDefaultWorkspace(actor: Actor) {
  const mine = await getMyWorkspaces(actor.userId)
  if (mine.length > 0) return { id: mine[0].id, name: mine[0].name }
  const { workspace } = await createWorkspace(actor, '우리 팀')
  return { id: workspace.id, name: workspace.name }
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

export async function getWorkspace(actor: Actor, workspaceId: string) {
  await assertWorkspaceMember(actor.userId, workspaceId)
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!ws) throw new NotFound('Workspace')
  return ws
}
