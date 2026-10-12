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
import { and, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm'
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

/**
 * 워크스페이스 역할만 있을 때의 기본 페이지 권한.
 * 공유 화면이 "이 사람은 왜 이 권한인가"를 설명하려면 이 규칙이 필요하다 —
 * 규칙을 복사해 두면 갈라지므로 여기서 내보낸다.
 */
export function defaultLevelForRole(role: WorkspaceRole | null): PermissionLevel | null {
  return role ? ROLE_DEFAULT[role] : null
}

/** 권한 세기 비교용. 숫자가 클수록 강하다. */
export const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = RANK

export async function assertWorkspaceMember(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole> {
  const role = await getWorkspaceRole(userId, workspaceId)
  if (!role) throw new Forbidden('이 워크스페이스의 멤버가 아닙니다')
  return role
}

/**
 * owner / admin 만 통과.
 * 프로젝트 룸 이름 바꾸기처럼 **룸 설정 자체**를 건드리는 동작에 쓴다.
 * 문서 권한(page_permissions)과는 무관하다 — 그건 resolvePageAccess 쪽이다.
 */
export async function assertWorkspaceAdmin(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole> {
  const role = await getWorkspaceRole(userId, workspaceId)
  if (role !== 'owner' && role !== 'admin') {
    throw new Forbidden('이 프로젝트 룸의 관리자만 할 수 있습니다')
  }
  return role
}

/** pages.path 에서 조상 id 를 깊은 순서로 뽑는다 (가까운 조상이 먼저) */
export function ancestorIdsFromPath(path: string): string[] {
  return path.split('/').filter(Boolean).reverse()
}

/** 바깥 질의의 페이지 컬럼. drizzle 컬럼 객체거나 별칭을 쓴 생 SQL 조각 */
type PageCols = { id: SQL | AnyColumn; path: SQL | AnyColumn }

/**
 * "게스트가 읽을 수 있는 페이지" 를 SQL 조건 하나로.
 *
 * resolvePageAccess 와 같은 규칙이다 — 페이지 자신이나 조상에 이 사람의 명시 권한이
 * 있으면 읽는다. 조상은 path('/루트/…/부모/') 에 들어 있으므로 LIKE 한 번이면 된다
 * (id 는 UUID 라 LIKE 의 특수문자 % _ 가 없다).
 *
 * cols 는 바깥 질의의 페이지 컬럼이다. drizzle 질의면 pages.id / pages.path 를,
 * 별칭을 쓴 생 SQL 이면 sql.raw('p.id') 처럼 넘긴다.
 *
 * ★ 목록·검색은 **게스트일 때** 이 조건을 붙인다 (pages.ts 의 트리·검색·최근·휴지통, page-content.ts 의 백링크)
 *   예전에는 목록·검색이 멤버인지만 봐서, "명시적으로 공유된 페이지만" 보는 게스트에게도
 *   모든 제목과 본문 발췌(검색 결과 160자)가 나갔다 — MCP 로도. 페이지 하나를 여는 경로만
 *   resolvePageAccess 를 지났다. 멤버 이상은 모든 페이지를 읽을 수 있으므로(명시 권한은
 *   등급만 바꾸고 "안 보임" 은 없다) 조건을 붙이지 않는다.
 */
export function readableByGuest(userId: string, cols: PageCols): SQL {
  return sql`EXISTS (
    SELECT 1 FROM page_permissions pp
     WHERE pp.user_id = ${userId}
       AND (pp.page_id = ${cols.id} OR ${cols.path} LIKE '%/' || pp.page_id::text || '/%')
  )`
}

/**
 * 유효 권한을 계산한다. 접근 불가면 null.
 * 페이지가 없으면 NotFound (존재 여부 자체는 숨기지 않는다 — 내부 팀 도구이므로).
 *
 * ★ 요청 단위 캐시 — getWorkspaceRole 과 같은 이유다.
 *   문서 화면 하나가 권한을 여러 번 묻는다: 본문 머리(getPageMeta), 데이터베이스인지,
 *   코멘트 수, 백링크가 각자 assertCanRead 를 부른다. 예전에는 그때마다 페이지 행과 명시
 *   권한을 다시 읽었다(문서 하나에 같은 쿼리 쌍이 네 번). 인자가 문자열 둘이라 캐시 키로 맞다.
 *   한 요청 안에서 권한을 바꾸고 다시 묻는 코드는 없다 — 바꾸는 액션은 revalidate 뒤
 *   **다음** 요청에서 새로 읽는다.
 */
export const resolvePageAccess = cache(async function resolvePageAccess(
  userId: string,
  pageId: string,
): Promise<{ level: PermissionLevel; workspaceId: string; role: WorkspaceRole | null } | null> {
  const [page] = await db
    .select({ id: pages.id, workspaceId: pages.workspaceId, path: pages.path })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
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
})

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
