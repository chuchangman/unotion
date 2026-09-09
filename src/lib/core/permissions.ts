/**
 * 권한 게이트. lib/core 의 모든 쓰기/읽기 함수가 여기를 먼저 통과한다.
 *
 * 유효 권한 결정 순서:
 *   1) 페이지 자신 또는 가장 가까운 조상에 걸린 명시적 page_permissions
 *   2) 없으면 워크스페이스 멤버십 기반 기본값 (owner/admin=full, member=edit, guest=없음)
 *
 * 조상은 pages.path 문자열('/rootId/childId/')에서 파싱한다 — 추가 쿼리가 없다.
 */
import { cache } from 'react'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from './db'
import { pages, pagePermissions, workspaceMembers } from './schema'
import { Forbidden, NotFound } from './errors'
import type { PermissionLevel } from './schema'

const RANK: Record<PermissionLevel, number> = { read: 0, comment: 1, edit: 2, full: 3 }

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

/** 워크스페이스 역할 → 명시적 권한이 없을 때의 기본 페이지 권한 */
const ROLE_DEFAULT: Record<WorkspaceRole, PermissionLevel | null> = {
  owner: 'full',
  admin: 'full',
  member: 'edit',
  guest: null, // 게스트는 명시적으로 공유된 페이지만 본다
}

/**
 * ★ 요청 단위 캐시.
 *
 * 권한 검사는 거의 모든 core 함수의 첫 줄이라, 한 요청 안에서 같은
 * (userId, workspaceId) 조회가 여러 번 일어난다. 페이지 보드가 두 칸이면
 * 목록 조회만으로도 이 쿼리가 네 번 나갔다.
 *
 * React 의 cache() 는 요청 스코프 메모이제이션이라 요청이 끝나면 사라진다.
 * lib/core 는 원래 프레임워크를 몰라야 하지만, 이건 서버 실행 환경(웹/MCP 모두
 * React 서버 런타임)에서만 의미가 있고 동작도 동일해서 예외로 둔다.
 */
export const getWorkspaceRole = cache(async function getWorkspaceRole(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
    ))
    .limit(1)
  return (row?.role as WorkspaceRole) ?? null
})

export async function assertWorkspaceMember(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole> {
  const role = await getWorkspaceRole(userId, workspaceId)
  if (!role) throw new Forbidden('이 워크스페이스의 멤버가 아닙니다')
  return role
}

/** pages.path 에서 조상 id 를 깊은 순서로 뽑는다 (가까운 조상이 먼저) */
export function ancestorIdsFromPath(path: string): string[] {
  return path.split('/').filter(Boolean).reverse()
}

/**
 * 유효 권한을 계산한다. 접근 불가면 null.
 * 페이지가 없으면 NotFound (존재 여부 자체는 숨기지 않는다 — 내부 팀 도구이므로).
 */
export async function resolvePageAccess(
  userId: string,
  pageId: string,
  /**
   * 호출자가 이미 그 행을 가지고 있으면 넘긴다 — 같은 요청에서 pages 를
   * 두 번 조회하지 않기 위한 것이다 (페이지 뷰가 그런 경우였다).
   */
  known?: { id: string; workspaceId: string; path: string },
): Promise<{ level: PermissionLevel; workspaceId: string; role: WorkspaceRole | null } | null> {
  const page = known ?? (await db
    .select({ id: pages.id, workspaceId: pages.workspaceId, path: pages.path })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1))[0]
  if (!page) throw new NotFound('Page')

  const chain = [page.id, ...ancestorIdsFromPath(page.path)]

  const explicit = await db
    .select({ pageId: pagePermissions.pageId, level: pagePermissions.level })
    .from(pagePermissions)
    .where(and(
      eq(pagePermissions.userId, userId),
      inArray(pagePermissions.pageId, chain),
    ))

  // 체인에서 가장 가까운(=chain 배열에서 먼저 나오는) 명시적 권한이 이긴다
  if (explicit.length > 0) {
    const byId = new Map(explicit.map((e) => [e.pageId, e.level]))
    for (const id of chain) {
      const level = byId.get(id)
      if (level) {
        const role = await getWorkspaceRole(userId, page.workspaceId)
        return { level, workspaceId: page.workspaceId, role }
      }
    }
  }

  const role = await getWorkspaceRole(userId, page.workspaceId)
  if (!role) return null
  const level = ROLE_DEFAULT[role]
  if (!level) return null
  return { level, workspaceId: page.workspaceId, role }
}

async function assertLevel(userId: string, pageId: string, min: PermissionLevel) {
  const access = await resolvePageAccess(userId, pageId)
  if (!access || RANK[access.level] < RANK[min]) {
    throw new Forbidden(`이 페이지에 대한 ${min} 권한이 없습니다`)
  }
  return access
}

export const assertCanRead = (u: string, p: string) => assertLevel(u, p, 'read')
export const assertCanComment = (u: string, p: string) => assertLevel(u, p, 'comment')
export const assertCanEdit = (u: string, p: string) => assertLevel(u, p, 'edit')
export const assertCanManage = (u: string, p: string) => assertLevel(u, p, 'full')
