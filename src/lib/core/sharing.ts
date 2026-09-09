/**
 * 페이지별 공유(권한) 도메인.
 *
 * page_permissions 는 지금까지 **읽기 경로에만** 있었다 —
 * permissions.ts 의 resolvePageAccess 가 조상 체인을 훑어 유효 권한을 정하지만,
 * 그 행을 만드는 코드가 어디에도 없어서 사실상 워크스페이스 역할이 전부였다.
 * 이 파일이 그 쓰기 경로다.
 *
 * 규칙은 pages.ts 와 같다: 모든 export 함수는 첫 인자로 Actor 를 받고
 * 가장 먼저 assert* 를 호출한다.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db } from './db'
import { pages, pagePermissions, profiles, workspaceMembers } from './schema'
import type { PermissionLevel } from './schema'
import { InvalidInput, NotFound } from './errors'
import {
  ancestorIdsFromPath, assertCanManage, defaultLevelForRole, type WorkspaceRole,
} from './permissions'
import * as audit from './audit'
import type { Actor } from './actor'

export const LEVELS: readonly PermissionLevel[] = ['read', 'comment', 'edit', 'full']

export type SharingEntry = {
  userId: string
  displayName: string
  email: string
  role: WorkspaceRole
  /** 실제로 적용되는 권한. 접근 불가면 null */
  effective: PermissionLevel | null
  /** 이 페이지에 직접 지정된 권한 (없으면 null) */
  explicitHere: PermissionLevel | null
  /** 조상에서 물려받았다면 그 페이지 id */
  inheritedFrom: string | null
}

/**
 * 이 페이지의 공유 현황.
 *
 * 멤버마다 resolvePageAccess 를 부르면 사람 수만큼 왕복이 난다.
 * 대신 조상 체인의 명시 권한을 **한 번에** 읽고 메모리에서 같은 규칙으로 계산한다.
 * 규칙 자체(역할 기본값 · 가까운 조상 우선)는 permissions.ts 에서 가져온다.
 */
export async function getPageSharing(
  actor: Actor,
  pageId: string,
): Promise<{ entries: SharingEntry[]; canManage: boolean }> {
  const access = await assertCanManage(actor.userId, pageId)

  const [page] = await db
    .select({ id: pages.id, path: pages.path, workspaceId: pages.workspaceId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!page) throw new NotFound('Page')

  // 가까운 조상이 먼저 오도록 — resolvePageAccess 와 같은 순서다
  const chain = [page.id, ...ancestorIdsFromPath(page.path)]

  const [members, explicit] = await Promise.all([
    db
      .select({
        userId: profiles.id,
        displayName: profiles.displayName,
        email: profiles.email,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(profiles, eq(profiles.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, page.workspaceId)),
    db
      .select({
        pageId: pagePermissions.pageId,
        userId: pagePermissions.userId,
        level: pagePermissions.level,
      })
      .from(pagePermissions)
      .where(inArray(pagePermissions.pageId, chain)),
  ])

  const byUser = new Map<string, Map<string, PermissionLevel>>()
  for (const row of explicit) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, new Map())
    byUser.get(row.userId)!.set(row.pageId, row.level)
  }

  const entries: SharingEntry[] = members.map((m) => {
    const perms = byUser.get(m.userId)
    const explicitHere = perms?.get(page.id) ?? null

    let effective: PermissionLevel | null = null
    let inheritedFrom: string | null = null

    if (perms) {
      for (const id of chain) {
        const level = perms.get(id)
        if (level) {
          effective = level
          inheritedFrom = id === page.id ? null : id
          break
        }
      }
    }
    if (!effective) effective = defaultLevelForRole(m.role as WorkspaceRole)

    return {
      userId: m.userId,
      displayName: m.displayName,
      email: m.email,
      role: m.role as WorkspaceRole,
      effective,
      explicitHere,
      inheritedFrom,
    }
  })

  entries.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'))
  return { entries, canManage: access.level === 'full' }
}

/** 이 페이지에 특정 사용자의 권한을 명시적으로 건다 */
export async function setPagePermission(
  actor: Actor,
  pageId: string,
  userId: string,
  level: PermissionLevel,
): Promise<void> {
  const access = await assertCanManage(actor.userId, pageId)
  if (!LEVELS.includes(level)) throw new InvalidInput('알 수 없는 권한 등급입니다')

  /**
   * 대상이 이 워크스페이스 멤버인지 확인한다.
   * 확인하지 않으면 남의 워크스페이스 사용자에게도 권한을 걸 수 있고,
   * 그 사람은 resolvePageAccess 의 명시 권한 분기를 타고 문서를 읽게 된다.
   */
  const [member] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, access.workspaceId),
      eq(workspaceMembers.userId, userId),
    ))
    .limit(1)
  if (!member) throw new InvalidInput('이 워크스페이스의 멤버가 아닙니다')

  await db
    .insert(pagePermissions)
    .values({ pageId, userId, level })
    .onConflictDoUpdate({
      target: [pagePermissions.pageId, pagePermissions.userId],
      set: { level },
    })

  await audit.record(actor, 'page.share', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { userId, level },
  })
}

/**
 * 명시 권한을 지운다. 지우면 조상 또는 워크스페이스 기본값으로 되돌아간다
 * (차단이 아니다 — 차단하려면 read 보다 낮은 등급이 필요한데 그런 건 없다).
 */
export async function clearPagePermission(
  actor: Actor,
  pageId: string,
  userId: string,
): Promise<void> {
  const access = await assertCanManage(actor.userId, pageId)

  await db.delete(pagePermissions).where(and(
    eq(pagePermissions.pageId, pageId),
    eq(pagePermissions.userId, userId),
  ))

  await audit.record(actor, 'page.unshare', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { userId },
  })
}
