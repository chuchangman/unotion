/**
 * 페이지 도메인. 웹 UI / REST / MCP 가 공유하는 유일한 진입점.
 *
 * 규칙: 모든 export 함수는 첫 인자로 Actor 를 받고, 가장 먼저 assert* 를 호출한다.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { generateKeyBetween } from 'fractional-indexing'
import { db } from './db'
import { pageLinks, pages, pageVersions, profiles } from './schema'
import { InvalidInput, NotFound } from './errors'
import { assertCanEdit, assertCanManage, assertCanRead, assertWorkspaceMember, resolvePageAccess } from './permissions'
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

async function loadPage(pageId: string): Promise<PageRow> {
  const [row] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1)
  if (!row) throw new NotFound('Page')
  return row
}

/** 형제들 맨 끝에 놓을 sortKey */
async function nextSortKey(workspaceId: string, parentId: string | null): Promise<string> {
  const [last] = await db
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

/** 사이드바용 트리. 재귀 CTE 한 방. */
export async function getPageTree(actor: Actor, workspaceId: string): Promise<TreeNode[]> {
  await assertWorkspaceMember(actor.userId, workspaceId)

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

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    icon: r.icon as PageRow['icon'],
    parentId: (r.parent_id as string | null) ?? null,
    sortKey: r.sort_key as string,
    hasChildren: Boolean(r.has_children),
  }))
}

export async function searchPages(
  actor: Actor,
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<Array<{ id: string; title: string; snippet: string }>> {
  await assertWorkspaceMember(actor.userId, workspaceId)
  if (!query.trim()) return []

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
  await assertWorkspaceMember(actor.userId, workspaceId)

  const like = `%${query}%`
  const rows = await db
    .select({ id: pages.id, title: pages.title, icon: pages.icon })
    .from(pages)
    .where(and(
      eq(pages.workspaceId, workspaceId),
      eq(pages.isTrashed, false),
      isNull(pages.collectionId),
      query.trim() ? sql`${pages.title} ILIKE ${like}` : sql`true`,
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
  await assertWorkspaceMember(actor.userId, workspaceId)
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
    contentJson?: unknown
    plainText?: string
    /** 데이터베이스의 행으로 만들 때 채운다. collections.ts 가 넘긴다 */
    collectionId?: string | null
    properties?: Record<string, unknown>
  },
): Promise<PageRow> {
  const parentId = input.parentId ?? null

  if (parentId) {
    await assertCanEdit(actor.userId, parentId)
  } else {
    await assertWorkspaceMember(actor.userId, input.workspaceId)
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
    contentJson: input.contentJson ?? null,
    plainText: input.plainText ?? '',
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
): Promise<PageRow> {
  const access = await assertCanEdit(actor.userId, pageId)

  const [row] = await db.update(pages)
    .set({ ...patch, lastEditedBy: actor.userId, updatedAt: new Date() })
    .where(eq(pages.id, pageId))
    .returning()

  await audit.record(actor, 'page.update_meta', {
    workspaceId: access.workspaceId, targetId: pageId, meta: patch,
  })
  return row
}

/**
 * 본문 저장. ydoc 이 진실이고 contentJson/plainText 는 파생 스냅샷이다.
 * 웹 에디터는 디바운스로, MCP 는 마크다운→블록 변환 후 호출한다.
 */
export async function savePageContent(
  actor: Actor,
  pageId: string,
  input: {
    contentJson?: unknown
    plainText: string
    ydoc?: Buffer | null
    title?: string
    /**
     * 본문이 가리키는 페이지 id 들 (백링크용).
     * **바뀌었을 때만** 보낸다 — 자동저장마다 링크 테이블을 다시 쓰면
     * 2초짜리 저장 경로에 쓰기 왕복이 두 개(delete + insert) 늘 붙는다.
     */
    links?: string[]
  },
): Promise<void> {
  const access = await assertCanEdit(actor.userId, pageId)

  await db.update(pages).set({
    /**
     * content_json 은 넘어온 경우에만 쓴다.
     *
     * 웹 에디터는 더 이상 보내지 않는다 — ydoc 이 본문의 진실이고
     * 이 컬럼을 읽는 곳이 없는데도 자동저장마다 100KB 짜리 JSON 을
     * 같이 실어 보내고 있었다 (큰 문서 기준 페이로드가 두 배였다).
     * MCP 는 마크다운을 블록으로 바꾼 결과를 그대로 넘기므로 계속 채운다.
     */
    ...(input.contentJson !== undefined ? { contentJson: input.contentJson } : {}),
    plainText: input.plainText,
    ...(input.ydoc ? { ydoc: input.ydoc } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    lastEditedBy: actor.userId,
    updatedAt: new Date(),
  }).where(eq(pages.id, pageId))

  if (input.links !== undefined) await replaceOutgoingLinks(pageId, input.links)

  /**
   * 자동저장은 감사 로그에 남기지 않는다.
   *
   * 에디터가 2초마다 저장하므로 이 한 줄이 전체 감사 로그의 78% 를 차지했고
   * (실측 303/387건), 저장할 때마다 DB 쓰기 왕복이 하나씩 더 붙었다.
   * "누가 언제 고쳤나" 는 pages.last_edited_by / updated_at 이 이미 담고 있다.
   *
   * 다만 MCP 경유 변경은 남긴다 — 출처 추적이 이 로그의 존재 이유다.
   */
  if (actor.source !== 'web') {
    await audit.record(actor, 'page.save_content', {
      workspaceId: access.workspaceId, targetId: pageId,
      meta: { chars: input.plainText.length },
    })
  }
}

/**
 * 되돌리기용 스냅샷. 저장마다가 아니라 주기적/명시적으로 호출한다.
 *
 * content_json 은 더 이상 상시 갱신되지 않으므로 여기서 ydoc 을 풀어
 * 그 시점의 블록을 만들어 넣는다. 이쪽이 항상 최신이다.
 */
export async function snapshotVersion(actor: Actor, pageId: string): Promise<void> {
  await assertCanEdit(actor.userId, pageId)
  const page = await loadPage(pageId)
  const { ydocBytesToBlocks } = await import('./markdown')
  const blocks = page.ydoc ? await ydocBytesToBlocks(page.ydoc) : page.contentJson

  await db.insert(pageVersions).values({
    pageId,
    title: page.title,
    /**
     * NULL 을 넣지 않는다.
     *
     * 갓 만든 페이지는 ydoc 도 content_json 도 없어서 blocks 가 null 이 되는데,
     * 그대로 저장하면 나중에 그 버전으로 되돌릴 때 블록 변환기가 null 을 받아 죽는다.
     * "빈 문서"는 null 이 아니라 빈 배열이다.
     */
    contentJson: blocks ?? [],
    authorId: actor.userId,
  })
}

/** BlockNote 는 최소 한 블록을 요구한다. 빈 문서는 빈 문단 하나로 표현한다. */
const EMPTY_DOC = [{ type: 'paragraph' }]

/**
 * 이 페이지에서 나가는 링크를 통째로 갈아끼운다.
 *
 * 자기 자신을 가리키는 링크는 버린다 — 백링크 목록에 자기가 나오면 헷갈리기만 한다.
 * 대상 페이지가 지워졌으면 FK 가 막으므로, 실재하는 페이지만 남긴다.
 */
async function replaceOutgoingLinks(fromPageId: string, toIds: string[]): Promise<void> {
  const targets = [...new Set(toIds)].filter((id) => id && id !== fromPageId)

  await db.delete(pageLinks).where(eq(pageLinks.fromPageId, fromPageId))
  if (targets.length === 0) return

  const alive = await db
    .select({ id: pages.id })
    .from(pages)
    .where(inArray(pages.id, targets))

  if (alive.length === 0) return
  await db.insert(pageLinks)
    .values(alive.map((p) => ({ fromPageId, toPageId: p.id })))
    .onConflictDoNothing()
}

export type Backlink = { id: string; title: string; icon: PageRow['icon'] }

/** 이 페이지를 본문에서 가리키는 페이지들 */
export async function listBacklinks(actor: Actor, pageId: string): Promise<Backlink[]> {
  await assertCanRead(actor.userId, pageId)

  return db
    .select({ id: pages.id, title: pages.title, icon: pages.icon })
    .from(pageLinks)
    .innerJoin(pages, eq(pages.id, pageLinks.fromPageId))
    .where(and(eq(pageLinks.toPageId, pageId), eq(pages.isTrashed, false)))
    .orderBy(asc(pages.title))
    .limit(50)
}

/** 스냅샷 최소 간격. 자동저장은 2초마다 도는데 그때마다 찍으면 버전이 수천 개가 된다. */
export const VERSION_MIN_GAP_MS = 10 * 60 * 1000

export type PageVersionMeta = {
  id: string
  title: string
  authorId: string | null
  authorName: string | null
  createdAt: Date
}

/**
 * 마지막 스냅샷이 충분히 오래됐을 때만 찍는다.
 *
 * 에디터가 저장 직전에 부른다. 그 시점의 ydoc 은 **아직 이번 편집이 반영되기 전**이므로,
 * 결과적으로 "편집을 시작하기 직전 상태"가 남는다 — 되돌릴 때 원하는 게 정확히 그것이다.
 *
 * 클라이언트도 같은 간격으로 자체 제한하지만, 여러 명이 같은 문서를 편집할 때를 위해
 * 서버에서도 한 번 더 막는다.
 */
export async function snapshotVersionIfStale(actor: Actor, pageId: string): Promise<boolean> {
  await assertCanEdit(actor.userId, pageId)

  const [last] = await db
    .select({ createdAt: pageVersions.createdAt })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.createdAt))
    .limit(1)

  if (last && Date.now() - last.createdAt.getTime() < VERSION_MIN_GAP_MS) return false

  await snapshotVersion(actor, pageId)
  return true
}

export async function listVersions(
  actor: Actor,
  pageId: string,
  limit = 30,
): Promise<PageVersionMeta[]> {
  await assertCanRead(actor.userId, pageId)
  return db
    .select({
      id: pageVersions.id,
      title: pageVersions.title,
      authorId: pageVersions.authorId,
      authorName: profiles.displayName,
      createdAt: pageVersions.createdAt,
    })
    .from(pageVersions)
    // 작성자가 워크스페이스를 떠나 프로필이 지워졌어도 버전은 남아야 하므로 LEFT JOIN
    .leftJoin(profiles, eq(profiles.id, pageVersions.authorId))
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.createdAt))
    .limit(limit)
}

/**
 * 특정 버전으로 되돌린다.
 *
 * ★ ydoc 을 갱신한다. content_json 만 바꾸면 웹 에디터가 다음 저장 때
 *   자기 ydoc 으로 덮어써서 되돌리기가 사라진다 (MCP 쓰기와 같은 이유).
 *
 * 되돌리기 직전 상태를 먼저 스냅샷으로 남긴다 — **되돌리기도 되돌릴 수 있어야 한다.**
 */
export async function restoreVersion(
  actor: Actor,
  pageId: string,
  versionId: string,
): Promise<void> {
  const access = await assertCanEdit(actor.userId, pageId)

  const [version] = await db
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.id, versionId), eq(pageVersions.pageId, pageId)))
    .limit(1)
  if (!version) throw new NotFound('Version')

  await snapshotVersion(actor, pageId)

  const page = await loadPage(pageId)
  const { applyBlocks, blocksToMarkdown } = await import('./markdown')

  // 예전에 NULL 로 저장된 버전이 남아 있을 수 있다
  const snapshot = Array.isArray(version.contentJson) && version.contentJson.length > 0
    ? version.contentJson
    : EMPTY_DOC

  const applied = await applyBlocks(page.ydoc, snapshot)

  await db.update(pages).set({
    ydoc: applied.ydoc,
    contentJson: applied.blocks,
    plainText: await blocksToMarkdown(applied.blocks),
    title: version.title,
    lastEditedBy: actor.userId,
    updatedAt: new Date(),
  }).where(eq(pages.id, pageId))

  await audit.record(actor, 'page.restore_version', {
    workspaceId: access.workspaceId,
    targetId: pageId,
    meta: { versionId, versionCreatedAt: version.createdAt.toISOString() },
  })
}

/**
 * 이동 + 순서 변경. 서브트리 path 를 한 번의 UPDATE 로 다시 쓴다.
 * beforeId/afterId 로 형제 사이 위치를 지정한다.
 */
export async function movePage(
  actor: Actor,
  pageId: string,
  target: { parentId: string | null; afterId?: string | null; beforeId?: string | null },
): Promise<void> {
  const access = await assertCanEdit(actor.userId, pageId)
  if (target.parentId) await assertCanEdit(actor.userId, target.parentId)

  const page = await loadPage(pageId)
  const oldPrefix = `${page.path}${page.id}/`

  const parent = target.parentId ? await loadPage(target.parentId) : null
  if (parent) {
    if (parent.id === page.id) throw new InvalidInput('페이지를 자기 자신 안으로 옮길 수 없습니다')
    if (parent.path === oldPrefix || parent.path.startsWith(oldPrefix)) {
      throw new InvalidInput('페이지를 자기 하위 페이지 안으로 옮길 수 없습니다')
    }
  }

  const [after] = target.afterId
    ? await db.select({ sortKey: pages.sortKey }).from(pages).where(eq(pages.id, target.afterId)).limit(1)
    : []
  const [before] = target.beforeId
    ? await db.select({ sortKey: pages.sortKey }).from(pages).where(eq(pages.id, target.beforeId)).limit(1)
    : []

  const sortKey = (after || before)
    ? generateKeyBetween(after?.sortKey ?? null, before?.sortKey ?? null)
    : await nextSortKey(page.workspaceId, target.parentId)

  const newPath = childPath(parent)
  const newPrefix = `${newPath}${page.id}/`

  await db.transaction(async (tx) => {
    await tx.update(pages)
      .set({ parentId: target.parentId, path: newPath, sortKey, updatedAt: new Date() })
      .where(eq(pages.id, pageId))

    await tx.execute(sql`
      UPDATE pages
         SET path = ${newPrefix} || substring(path from ${oldPrefix.length + 1})
       WHERE workspace_id = ${page.workspaceId}
         AND path LIKE ${oldPrefix + '%'}
    `)
  })

  await audit.record(actor, 'page.move', {
    workspaceId: access.workspaceId, targetId: pageId,
    meta: { from: page.parentId, to: target.parentId },
  })
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
  await assertWorkspaceMember(actor.userId, workspaceId)

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
