/**
 * 페이지 도메인 — 트리 · 검색 · 만들기 · 이동 · 휴지통. 웹 UI / REST / MCP 가 공유하는 진입점.
 * 본문(ydoc) · 백링크 · 버전 기록은 page-content.ts 에 있다.
 *
 * 규칙: 모든 export 함수는 첫 인자로 Actor 를 받고, 가장 먼저 assert* 를 호출한다.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { generateKeyBetween } from 'fractional-indexing'
import { db, type Executor } from './db'
import { pages } from './schema'
import type { PermissionLevel } from './schema'
import { Forbidden, InvalidInput, NotFound } from './errors'
import {
  assertCanEdit, assertCanManage, assertCanRead, assertWorkspaceMember, readableByGuest, resolvePageAccess,
} from './permissions'
import { xactLock } from './locks'
import * as audit from './audit'
import type { Actor } from './actor'

export type PageRow = typeof pages.$inferSelect

export type TreeNode = {
  id: string
  title: string
  icon: PageRow['icon']
  parentId: string | null
  sortKey: string
  hasChildren: boolean
}

/** 자식의 path = 부모의 path + 부모 id + '/' */
function childPath(parent: { path: string; id: string } | null): string {
  return parent ? `${parent.path}${parent.id}/` : '/'
}

async function loadPage(pageId: string, ex: Executor = db): Promise<PageRow> {
  const [row] = await ex.select().from(pages).where(eq(pages.id, pageId)).limit(1)
  if (!row) throw new NotFound('Page')
  return row
}

/** 형제들 맨 끝에 놓을 sortKey */
async function nextSortKey(workspaceId: string, parentId: string | null, ex: Executor = db): Promise<string> {
  const [last] = await ex
    .select({ sortKey: pages.sortKey })
    .from(pages)
    .where(and(
      eq(pages.workspaceId, workspaceId),
      parentId === null ? isNull(pages.parentId) : eq(pages.parentId, parentId),
      eq(pages.isTrashed, false),
    ))
    .orderBy(desc(pages.sortKey))
    .limit(1)
  return generateKeyBetween(last?.sortKey ?? null, null)
}

// ─────────────────────────────────────────── 읽기

export async function getPage(actor: Actor, pageId: string): Promise<PageRow> {
  await assertCanRead(actor.userId, pageId)
  return loadPage(pageId)
}

export type PageMeta = {
  id: string
  workspaceId: string
  title: string
  icon: PageRow['icon']
  /** 본문이 비었는지 (평문 기준) — "데이터베이스로 바꾸기" 버튼을 띄울지 */
  isEmpty: boolean
  /** 이 사람의 유효 권한 */
  level: PermissionLevel
}

/**
 * 화면 머리에 필요한 것만. ydoc(본문 바이트)·평문을 싣지 않는다.
 *
 * getPage 는 `select *` 라 큰 문서면 수백 KB 짜리 ydoc 을 DB 에서 끌어오는데,
 * 문서 화면(서버 컴포넌트)과 미리보기는 그걸 쓰지 않는다 — 본문은 에디터가 따로 받는다.
 * 권한 계산 결과(level)도 같이 돌려줘서 호출부가 한 번 더 계산하지 않게 한다.
 */
export async function getPageMeta(actor: Actor, pageId: string): Promise<PageMeta> {
  const access = await assertCanRead(actor.userId, pageId)
  const [row] = await db
    .select({
      id: pages.id,
      workspaceId: pages.workspaceId,
      title: pages.title,
      icon: pages.icon,
      isEmpty: sql<boolean>`btrim(${pages.plainText}) = ''`,
    })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!row) throw new NotFound('Page')
  return { ...row, level: access.level }
}

/** 생 SQL 로 뽑은 트리 행 → TreeNode */
function toTreeNodes(rows: unknown): TreeNode[] {
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    icon: r.icon as PageRow['icon'],
    parentId: (r.parent_id as string | null) ?? null,
    sortKey: r.sort_key as string,
    hasChildren: Boolean(r.has_children),
  }))
}

/** 별칭 없이 FROM pages 로 쓴 생 SQL 에서 게스트 조건을 붙일 때 */
const RAW_PAGES = { id: sql.raw('pages.id'), path: sql.raw('pages.path') }
/** FROM pages p 로 쓴 생 SQL 에서 */
const RAW_P = { id: sql.raw('p.id'), path: sql.raw('p.path') }

/** 사이드바용 트리. 재귀 CTE 한 방. */
export async function getPageTree(actor: Actor, workspaceId: string): Promise<TreeNode[]> {
  const role = await assertWorkspaceMember(actor.userId, workspaceId)
  if (role === 'guest') return getGuestTree(actor.userId, workspaceId)

  const rows = await db.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT p.id, p.title, p.icon, p.parent_id, p.sort_key, 0 AS depth
        FROM pages p
       WHERE p.workspace_id = ${workspaceId}
         AND p.parent_id IS NULL
         AND p.is_trashed = false
         AND p.collection_id IS NULL
      UNION ALL
      SELECT c.id, c.title, c.icon, c.parent_id, c.sort_key, t.depth + 1
        FROM pages c
        JOIN tree t ON c.parent_id = t.id
       WHERE c.is_trashed = false
         AND c.collection_id IS NULL
         AND t.depth < 30
    )
    SELECT t.*, EXISTS (
      SELECT 1 FROM pages k
       WHERE k.parent_id = t.id AND k.is_trashed = false AND k.collection_id IS NULL
    ) AS has_children
      FROM tree t
     ORDER BY t.depth, t.sort_key
  `)

  return toTreeNodes(rows)
}

/**
 * 게스트의 트리 — 공유받은 페이지와 그 아래만.
 *
 * 공유받은 페이지의 조상은 볼 수 없어서 루트부터 내려가는 재귀로는 닿지 않는다.
 * 읽을 수 있는 페이지를 한 번에 뽑고, 부모가 목록에 없으면 최상위로 올린다 —
 * 사이드바는 parentId 로 묶어 그리므로 그걸로 충분하다. 얕은 것부터, 형제는 sortKey 순이다.
 */
async function getGuestTree(userId: string, workspaceId: string): Promise<TreeNode[]> {
  const rows = await db.execute(sql`
    SELECT p.id, p.title, p.icon, p.parent_id, p.sort_key,
           EXISTS (
             SELECT 1 FROM pages k
              WHERE k.parent_id = p.id AND k.is_trashed = false AND k.collection_id IS NULL
           ) AS has_children
      FROM pages p
     WHERE p.workspace_id = ${workspaceId}
       AND p.is_trashed = false
       AND p.collection_id IS NULL
       AND ${readableByGuest(userId, RAW_P)}
     ORDER BY length(p.path), p.sort_key
  `)

  const nodes = toTreeNodes(rows)
  const visible = new Set(nodes.map((n) => n.id))
  return nodes.map((n) => (n.parentId && !visible.has(n.parentId) ? { ...n, parentId: null } : n))
}

export async function searchPages(
  actor: Actor,
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<Array<{ id: string; title: string; snippet: string }>> {
  const role = await assertWorkspaceMember(actor.userId, workspaceId)
  if (!query.trim()) return []
  const onlyShared = role === 'guest' ? sql`AND ${readableByGuest(actor.userId, RAW_PAGES)}` : sql``

  // 한국어는 tsvector 토크나이저가 없어 부분일치가 안 된다("회의"로 "회의록" 못 찾음).
  // 트라이그램/ILIKE 를 주 수단으로, tsvector 는 영문 단어 매칭 보조로 쓴다.
  const like = `%${query}%`
  const rows = await db.execute(sql`
    SELECT id, title,
           substring(plain_text
                     from greatest(1, coalesce(nullif(position(${query} in plain_text), 0), 1) - 40)
                     for 160) AS snippet,
           greatest(
             similarity(title, ${query}) * 2,
             similarity(plain_text, ${query})
           ) AS score
      FROM pages
     WHERE workspace_id = ${workspaceId}
       AND is_trashed = false
       AND (title ILIKE ${like}
            OR plain_text ILIKE ${like}
            OR search_vector @@ websearch_to_tsquery('simple', ${query}))
       ${onlyShared}
     ORDER BY score DESC, updated_at DESC
     LIMIT ${limit}
  `)

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    title: (r.title as string) || '제목 없음',
    snippet: (r.snippet as string) ?? '',
  }))
}

/**
 * 본문에서 페이지를 링크할 때 쓰는 검색.
 * 아이콘이 필요하고(링크 앞에 붙는다) 발췌는 필요 없어서 searchPages 와 따로 둔다.
 */
export async function searchPagesForLink(
  actor: Actor,
  workspaceId: string,
  query: string,
  limit = 8,
): Promise<Array<{ id: string; title: string; icon: PageRow['icon'] }>> {
  const role = await assertWorkspaceMember(actor.userId, workspaceId)

  const like = `%${query}%`
  const rows = await db
    .select({ id: pages.id, title: pages.title, icon: pages.icon })
    .from(pages)
    .where(and(
      eq(pages.workspaceId, workspaceId),
      eq(pages.isTrashed, false),
      isNull(pages.collectionId),
      query.trim() ? sql`${pages.title} ILIKE ${like}` : sql`true`,
      role === 'guest' ? readableByGuest(actor.userId, pages) : undefined,
    ))
    .orderBy(desc(pages.updatedAt))
    .limit(limit)

  return rows
}

/** 특정 페이지의 바로 아래 자식들. 페이지 보드 블록이 쓴다. */
export async function listChildren(
  actor: Actor,
  parentId: string,
): Promise<Array<{ id: string; title: string; icon: PageRow['icon'] }>> {
  await assertCanRead(actor.userId, parentId)
  return db
    .select({ id: pages.id, title: pages.title, icon: pages.icon })
    .from(pages)
    .where(and(
      eq(pages.parentId, parentId),
      eq(pages.isTrashed, false),
      isNull(pages.collectionId),
    ))
    .orderBy(asc(pages.sortKey))
}

/**
 * 여러 부모의 자식을 한 번에 가져온다.
 * 페이지 보드는 칸마다 목록이 필요한데, 칸별로 부르면 칸 수만큼 왕복이 생긴다.
 */
export async function listChildrenBatch(
  actor: Actor,
  parentIds: string[],
): Promise<Record<string, Array<{ id: string; title: string; icon: PageRow['icon'] }>>> {
  const unique = [...new Set(parentIds)].filter(Boolean)
  if (unique.length === 0) return {}

  // 권한은 부모별로 확인한다 (한 칸이라도 못 보면 그 칸만 비운다)
  const allowed: string[] = []
  await Promise.all(unique.map(async (id) => {
    try {
      await assertCanRead(actor.userId, id)
      allowed.push(id)
    } catch { /* 접근 불가한 부모는 조용히 건너뛴다 */ }
  }))
  if (allowed.length === 0) return {}

  const rows = await db
    .select({ id: pages.id, title: pages.title, icon: pages.icon, parentId: pages.parentId })
    .from(pages)
    .where(and(
      inArray(pages.parentId, allowed),
      eq(pages.isTrashed, false),
      isNull(pages.collectionId),
    ))
    .orderBy(asc(pages.sortKey))

  const out: Record<string, Array<{ id: string; title: string; icon: PageRow['icon'] }>> = {}
  for (const id of allowed) out[id] = []
  for (const r of rows) {
    if (r.parentId) out[r.parentId]?.push({ id: r.id, title: r.title, icon: r.icon })
  }
  return out
}

/** "이번 주에 뭐 바뀌었어?" — MCP 에서 체감이 큰 툴 */
export async function getRecentChanges(
  actor: Actor,
  workspaceId: string,
  since: Date,
  limit = 50,
) {
  const role = await assertWorkspaceMember(actor.userId, workspaceId)
  return db
    .select({
      id: pages.id,
      title: pages.title,
      updatedAt: pages.updatedAt,
      lastEditedBy: pages.lastEditedBy,
    })
    .from(pages)
    .where(and(
      eq(pages.workspaceId, workspaceId),
      eq(pages.isTrashed, false),
      sql`${pages.updatedAt} >= ${since.toISOString()}`,
      role === 'guest' ? readableByGuest(actor.userId, pages) : undefined,
    ))
    .orderBy(desc(pages.updatedAt))
    .limit(limit)
}

// ─────────────────────────────────────────── 쓰기

export async function createPage(
  actor: Actor,
  input: {
    workspaceId: string
    parentId?: string | null
    title?: string
    icon?: PageRow['icon']
    /** 데이터베이스의 행으로 만들 때 채운다. collections.ts 가 넘긴다 */
    collectionId?: string | null
    properties?: Record<string, unknown>
  },
): Promise<PageRow> {
  const parentId = input.parentId ?? null

  if (parentId) {
    await assertCanEdit(actor.userId, parentId)
  } else {
    const role = await assertWorkspaceMember(actor.userId, input.workspaceId)
    // 게스트의 기본 권한은 "없음" 이라, 최상위에 만들면 만든 본인도 못 여는 문서가 된다
    if (role === 'guest') throw new Forbidden('게스트는 공유받은 문서 안에만 페이지를 만들 수 있습니다')
  }

  const parent = parentId ? await loadPage(parentId) : null
  if (parent && parent.workspaceId !== input.workspaceId) {
    throw new InvalidInput('부모 페이지가 다른 워크스페이스에 있습니다')
  }

  const [row] = await db.insert(pages).values({
    workspaceId: input.workspaceId,
    parentId,
    path: childPath(parent),
    sortKey: await nextSortKey(input.workspaceId, parentId),
    title: input.title ?? '',
    icon: input.icon ?? null,
    collectionId: input.collectionId ?? null,
    properties: input.properties ?? {},
    createdBy: actor.userId,
    lastEditedBy: actor.userId,
  }).returning()

  await audit.record(actor, 'page.create', {
    workspaceId: input.workspaceId,
    targetId: row.id,
    meta: { title: row.title, parentId },
  })
  return row
}

export async function updatePageMeta(
  actor: Actor,
  pageId: string,
  patch: { title?: string; icon?: PageRow['icon']; cover?: PageRow['cover'] },
  /**
   * audit: false — 제목을 치는 동안의 중간 저장. 600ms 마다 오므로 감사 로그에 남기면
   * 자동저장 때와 같은 문제(로그 대부분이 타이핑)가 된다. 입력을 마칠 때 한 번 남긴다.
   */
  opts: { audit?: boolean } = {},
): Promise<PageRow> {
  const access = await assertCanEdit(actor.userId, pageId)

  const [row] = await db.update(pages)
    .set({ ...patch, lastEditedBy: actor.userId, updatedAt: new Date() })
    .where(eq(pages.id, pageId))
    .returning()

  if (opts.audit !== false) {
    await audit.record(actor, 'page.update_meta', {
      workspaceId: access.workspaceId, targetId: pageId, meta: patch,
    })
  }
  return row
}

type MoveTarget = { parentId: string | null; afterId?: string | null; beforeId?: string | null }

/**
 * 이동 + 순서 변경. 서브트리 path 를 한 번의 UPDATE 로 다시 쓴다.
 * beforeId/afterId 로 형제 사이 위치를 지정한다.
 *
 * ★ 같은 룸의 이동은 한 줄로 선다 (트랜잭션 advisory lock).
 *   검사와 쓰기 사이에 다른 이동이 끼면, 두 사람이 A 를 B 밑으로 · B 를 A 밑으로 동시에
 *   옮겨 순환이 생긴다. 그래서 잠근 **뒤에** 행을 다시 읽고 검사한다. 이동은 드물어서
 *   룸 단위로 줄 세워도 기다릴 일이 없다.
 */
export async function movePage(actor: Actor, pageId: string, target: MoveTarget): Promise<void> {
  const access = await assertCanEdit(actor.userId, pageId)
  if (target.parentId) {
    await assertCanEdit(actor.userId, target.parentId)
  } else if (access.role === 'guest') {
    // 게스트의 기본 권한은 "없음" 이라 최상위로 옮기면 본인도 못 여는 문서가 된다 (createPage 와 같은 규칙)
    throw new Forbidden('게스트는 공유받은 문서 밖으로 옮길 수 없습니다')
  }

  const from = await db.transaction(async (tx) => {
    await tx.execute(xactLock('pageMove', access.workspaceId))
    const page = await loadPage(pageId, tx)
    const parent = target.parentId ? await loadPage(target.parentId, tx) : null
    assertMovable(page, parent)

    const sortKey = await sortKeyBetween(tx, page, target)
    const newPath = childPath(parent)
    const oldPrefix = `${page.path}${page.id}/`
    await tx.update(pages)
      .set({ parentId: target.parentId, path: newPath, sortKey, updatedAt: new Date() })
      .where(eq(pages.id, pageId))

    /**
     * ★ ::int 를 빼면 안 된다. 드라이버는 숫자 파라미터를 타입 없이 보내는데, 그러면
     *   Postgres 가 `substring(text FROM text)` — **정규식** 버전을 고른다. '76' 이라는 패턴은
     *   안 맞으니 NULL 이 나오고, path 가 NOT NULL 이라 하위 페이지가 있는 이동이 통째로
     *   실패했다 (test/sql/move-page.test.ts 가 잡았다. 옮기는 화면이 없어서 여태 안 드러났다).
     */
    await tx.execute(sql`
      UPDATE pages
         SET path = ${`${newPath}${page.id}/`} || substring(path from ${oldPrefix.length + 1}::int)
       WHERE workspace_id = ${page.workspaceId}
         AND path LIKE ${oldPrefix + '%'}
    `)
    return page.parentId
  })

  await audit.record(actor, 'page.move', {
    workspaceId: access.workspaceId, targetId: pageId,
    meta: { from, to: target.parentId },
  })
}

/** 옮길 수 있는 자리인지. 잠금 안에서 방금 읽은 행으로 본다 */
function assertMovable(page: PageRow, parent: PageRow | null) {
  // 행은 표 안에서만 산다 — 사이드바 트리에 없고, 옮기면 표에서 사라진다
  if (page.collectionId) throw new InvalidInput('데이터베이스의 행은 여기서 옮길 수 없습니다')
  if (!parent) return
  if (parent.id === page.id) throw new InvalidInput('페이지를 자기 자신 안으로 옮길 수 없습니다')
  if (parent.path.startsWith(`${page.path}${page.id}/`)) {
    throw new InvalidInput('페이지를 자기 하위 페이지 안으로 옮길 수 없습니다')
  }
  /**
   * 다른 룸의 페이지 밑으로는 못 옮긴다. 두 룸에 다 편집 권한이 있으면 권한 검사는
   * 통과하는데, 그대로 두면 workspace_id 는 옛 룸인 채 path 만 다른 룸을 가리켜서
   * 트리·권한·검색이 서로 다른 룸을 보게 된다. 룸 사이 이동은 복사로 따로 다뤄야 한다.
   */
  if (parent.workspaceId !== page.workspaceId) {
    throw new InvalidInput('다른 프로젝트 룸으로는 옮길 수 없습니다')
  }
  if (parent.collectionId) throw new InvalidInput('데이터베이스의 행 안으로는 옮길 수 없습니다')
}

/**
 * 기준 형제(afterId/beforeId) 사이의 정렬 키. 둘 다 없으면 새 부모의 맨 끝.
 *
 * 기준 형제는 **옮겨 갈 부모의 자식**이어야 한다. 엉뚱한 곳의 페이지를 넘기면 그쪽 정렬 키
 * 사이에 끼워져 순서가 뒤죽박죽이 되고, 순서가 뒤집혀 오면(after > before)
 * generateKeyBetween 이 예외를 던진다.
 */
async function sortKeyBetween(ex: Executor, page: PageRow, target: MoveTarget): Promise<string> {
  const keyOf = async (id: string | null | undefined) => {
    if (!id) return null
    const [row] = await ex
      .select({ sortKey: pages.sortKey, parentId: pages.parentId, workspaceId: pages.workspaceId })
      .from(pages)
      .where(eq(pages.id, id))
      .limit(1)
    if (!row || row.workspaceId !== page.workspaceId || row.parentId !== (target.parentId ?? null)) {
      throw new InvalidInput('옮길 위치가 올바르지 않습니다 — 트리를 새로고침해 주세요')
    }
    return row.sortKey
  }
  const afterKey = await keyOf(target.afterId)
  const beforeKey = await keyOf(target.beforeId)
  if (afterKey === null && beforeKey === null) return nextSortKey(page.workspaceId, target.parentId, ex)
  if (afterKey !== null && beforeKey !== null && afterKey >= beforeKey) {
    throw new InvalidInput('옮길 위치가 올바르지 않습니다 — 트리를 새로고침해 주세요')
  }
  return generateKeyBetween(afterKey, beforeKey)
}

/** 휴지통으로. 서브트리 전체가 함께 들어간다. */
export async function trashPage(actor: Actor, pageId: string): Promise<void> {
  const access = await assertCanEdit(actor.userId, pageId)
  const page = await loadPage(pageId)
  const prefix = `${page.path}${page.id}/`

  await db.execute(sql`
    UPDATE pages
       SET is_trashed = true, trashed_at = now()
     WHERE workspace_id = ${page.workspaceId}
       AND (id = ${pageId} OR path LIKE ${prefix + '%'})
  `)

  await audit.record(actor, 'page.trash', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { title: page.title },
  })
}

export type TrashedPage = {
  id: string
  title: string
  icon: PageRow['icon']
  trashedAt: Date | null
  /** 함께 지워진 하위 페이지 수. "이걸 되살리면 뭐가 딸려오나"를 보여주려는 것 */
  descendants: number
}

/**
 * 휴지통 목록.
 *
 * **맨 위 항목만** 보여준다 — 부모가 함께 지워진 페이지는 빼고,
 * 지우기를 실행한 그 페이지만 나열한다.
 * 하위까지 전부 나열하면 목록이 쓸모없어지고, 무엇보다
 * 자식만 되살리면 부모가 여전히 휴지통에 있어 트리 어디에도 안 나타난다
 * (getPageTree 는 루트부터 재귀하므로 조상이 끊기면 보이지 않는다).
 */
export async function listTrashed(
  actor: Actor,
  workspaceId: string,
): Promise<TrashedPage[]> {
  const role = await assertWorkspaceMember(actor.userId, workspaceId)
  const onlyShared = role === 'guest' ? sql`AND ${readableByGuest(actor.userId, RAW_P)}` : sql``

  const rows = await db.execute(sql`
    SELECT p.id, p.title, p.icon, p.trashed_at,
           (SELECT count(*) FROM pages c
             WHERE c.path LIKE p.path || p.id || '/%'
               AND c.is_trashed = true) AS descendants
      FROM pages p
      LEFT JOIN pages parent ON parent.id = p.parent_id
     WHERE p.workspace_id = ${workspaceId}
       AND p.is_trashed = true
       AND (p.parent_id IS NULL OR parent.is_trashed = false)
       ${onlyShared}
     ORDER BY p.trashed_at DESC NULLS LAST
     LIMIT 200
  `)

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    title: (r.title as string) || '제목 없음',
    icon: r.icon as PageRow['icon'],
    trashedAt: r.trashed_at ? new Date(r.trashed_at as string) : null,
    descendants: Number(r.descendants ?? 0),
  }))
}

/**
 * 영구 삭제. **되돌릴 수 없다.**
 *
 * 하위 페이지·컬렉션·버전은 FK 의 ON DELETE CASCADE 가 함께 지운다
 * (drizzle/0001 의 pages_parent_id_fk, collections_page_id_fk).
 *
 * 권한을 edit 이 아니라 **full 로 요구한다.** 휴지통으로 보내는 건 되돌릴 수 있지만
 * 이건 아니다 — 되돌릴 수 없는 삭제는 워크스페이스를 관리하는 사람만 하게 둔다.
 */
export async function deletePagePermanently(actor: Actor, pageId: string): Promise<void> {
  const access = await assertCanManage(actor.userId, pageId)
  const page = await loadPage(pageId)
  if (!page.isTrashed) {
    throw new InvalidInput('휴지통에 있는 페이지만 영구 삭제할 수 있습니다')
  }

  await db.delete(pages).where(eq(pages.id, pageId))

  await audit.record(actor, 'page.delete_permanently', {
    workspaceId: access.workspaceId,
    targetId: pageId,
    meta: { title: page.title },
  })
}

export async function restorePage(actor: Actor, pageId: string): Promise<void> {
  const access = await assertCanEdit(actor.userId, pageId)
  const page = await loadPage(pageId)
  const prefix = `${page.path}${page.id}/`

  await db.execute(sql`
    UPDATE pages
       SET is_trashed = false, trashed_at = NULL
     WHERE workspace_id = ${page.workspaceId}
       AND (id = ${pageId} OR path LIKE ${prefix + '%'})
  `)

  await audit.record(actor, 'page.restore', {
    workspaceId: access.workspaceId, targetId: pageId,
  })
}

export { resolvePageAccess }
