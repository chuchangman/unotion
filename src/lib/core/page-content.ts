/**
 * 페이지 본문(ydoc) · 링크(백링크) · 버전 기록.
 *
 * pages.ts 에서 떼어 왔다 — 그쪽은 트리 · 만들기 · 이동 · 휴지통이다. 본문의 쓰기는 전부
 * applyYdocUpdate 한 곳을 지난다 (웹 에디터 · MCP · 버전 되돌리기).
 *
 * 규칙은 pages.ts 와 같다: 모든 export 함수는 첫 인자로 Actor 를 받고, 가장 먼저 assert* 를 호출한다.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { db, type Executor } from './db'
import { pageLinks, pages, pageVersions, profiles } from './schema'
import { applyAndDetect, deriveFromYDoc, docFromState } from '@/lib/ydoc'
import { InvalidInput, NotFound } from './errors'
import { assertCanEdit, assertCanRead, readableByGuest } from './permissions'
import { xactLock } from './locks'
import * as audit from './audit'
import type { Actor } from './actor'
import type { PageRow } from './pages'

/**
 * 본문 상태를 읽는다.
 *
 * 상대 상태벡터를 주면 **그 사람이 없는 부분만** 돌려준다 — 탭으로 돌아왔을 때나
 * 재접속했을 때 끊긴 사이 쌓인 것만 받아 간다(MCP 가 쓴 문단 같은 것).
 * 서버의 상태벡터도 같이 준다. 클라이언트는 저장할 때 이것과의 차이만 보낸다.
 */
export async function loadYdocState(
  actor: Actor,
  pageId: string,
  clientStateVector?: Uint8Array,
): Promise<{ stateVector: Uint8Array; update: Uint8Array | null }> {
  await assertCanRead(actor.userId, pageId)

  const [row] = await db
    .select({ ydoc: pages.ydoc })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!row) throw new NotFound('Page')
  if (!row.ydoc || row.ydoc.byteLength === 0) {
    return { stateVector: Y.encodeStateVector(new Y.Doc()), update: null }
  }

  const stored = new Uint8Array(row.ydoc)
  try {
    return {
      stateVector: Y.encodeStateVectorFromUpdate(stored),
      update: clientStateVector ? Y.diffUpdate(stored, clientStateVector) : stored,
    }
  } catch {
    throw new InvalidInput('상태벡터 형식이 올바르지 않습니다')
  }
}

export type YdocSaveResult = {
  /** false 면 새로 더해진 게 없어서 DB 를 건드리지 않았다 */
  changed: boolean
  /** 저장 후 서버의 상태벡터. 클라이언트는 다음 저장 때 이것과의 차이만 보낸다 */
  stateVector: Uint8Array
  /**
   * 버전 스냅샷을 남길 때가 됐으면 **저장 직전** 상태. 아니면 null.
   * 변환(BlockNote)이 무거워서 잠금을 쥔 채 하지 않는다 — 호출부가 응답 뒤에
   * recordVersionSnapshot 으로 남긴다.
   */
  snapshotDue: { ydoc: Uint8Array; title: string } | null
}

/**
 * ★ 본문의 유일한 쓰기 경로. 웹 에디터·MCP·버전 되돌리기가 전부 여기로 온다.
 *
 * **덮어쓰지 않고 병합한다.** 예전에는 `ydoc = 보낸 것` 이었다. 그래서 문서를 열어 둔
 * 사람이 한 글자만 쳐도 그 사람이 가진 옛 상태가 DB 를 덮었고, 그 사이 MCP 가 붙인
 * 문단이나 다른 사람의 되돌리기가 사라졌다. 지금은 저장된 상태 위에 들어온 업데이트를
 * 얹는다 — CRDT 라 순서가 어떻든 결과가 같고, 무엇도 지워지지 않는다.
 *
 * 들어온 게 **새로 더하는 게 없으면 DB 를 건드리지 않는다.** 예전에는 문서를 열기만 해도
 * 3초 뒤 저장이 나가 last_edited_by / updated_at 이 열람자로 바뀌었다
 * ("최근 변경" 과 MCP 주간 보고가 열람 기록이 됐다).
 *
 * 평문(검색)과 링크(백링크)는 병합한 결과에서 서버가 뽑는다 — 클라이언트는 병합된
 * 전체를 모르기 때문이다. 링크 테이블은 목록이 바뀌었을 때만 다시 쓴다.
 *
 * 행 잠금(FOR UPDATE)으로 같은 페이지의 저장을 줄 세운다. 두 저장이 동시에 옛 상태를
 * 읽고 각자 합쳐 쓰면 한쪽이 사라지기 때문이다.
 */
export async function applyYdocUpdate(
  actor: Actor,
  pageId: string,
  update: Uint8Array,
  opts: { title?: string } = {},
): Promise<YdocSaveResult> {
  const access = await assertCanEdit(actor.userId, pageId)

  const result = await db.transaction(async (tx): Promise<YdocSaveResult> => {
    const [row] = await tx
      .select({ ydoc: pages.ydoc, title: pages.title })
      .from(pages)
      .where(eq(pages.id, pageId))
      .for('update')
    if (!row) throw new NotFound('Page')

    const doc = docFromState(row.ydoc)
    const before = deriveFromYDoc(doc)
    let changed: boolean
    try {
      changed = applyAndDetect(doc, update)
    } catch {
      throw new InvalidInput('본문 업데이트 형식이 올바르지 않습니다')
    }

    const titleChanged = opts.title !== undefined && opts.title !== row.title
    const stateVector = Y.encodeStateVector(doc)
    if (!changed && !titleChanged) return { changed: false, stateVector, snapshotDue: null }

    const after = changed ? deriveFromYDoc(doc) : before
    await tx.update(pages).set({
      // 다시 인코딩하면 지워진 내용의 본문이 GC 되어 저장 크기가 준다
      ...(changed ? { ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), plainText: after.plainText } : {}),
      ...(titleChanged ? { title: opts.title } : {}),
      lastEditedBy: actor.userId,
      updatedAt: new Date(),
    }).where(eq(pages.id, pageId))

    if (changed && !sameIds(before.links, after.links)) {
      await replaceOutgoingLinks(tx, pageId, after.links)
    }

    // 빈 문서의 "편집 직전" 은 되돌릴 가치가 없다
    const hadContent = !!row.ydoc && row.ydoc.byteLength > 0
    const snapshotDue = changed && hadContent && (await versionIsDue(tx, pageId))
      ? { ydoc: new Uint8Array(row.ydoc!), title: row.title }
      : null

    return { changed: true, stateVector, snapshotDue }
  })

  /**
   * 웹 자동저장은 감사 로그에 남기지 않는다.
   *
   * 에디터가 몇 초마다 저장하므로 이 한 줄이 전체 감사 로그의 78% 를 차지했고
   * (실측 303/387건), 저장할 때마다 DB 쓰기 왕복이 하나씩 더 붙었다.
   * "누가 언제 고쳤나" 는 pages.last_edited_by / updated_at 이 이미 담고 있다.
   *
   * 다만 MCP 경유 변경은 남긴다 — 출처 추적이 이 로그의 존재 이유다.
   */
  if (result.changed && actor.source !== 'web') {
    await audit.record(actor, 'page.save_content', {
      workspaceId: access.workspaceId, targetId: pageId,
      meta: { bytes: update.byteLength },
    })
  }
  return result
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/**
 * 되돌리기용 스냅샷. 저장마다가 아니라 주기적/명시적으로 호출한다.
 *
 * content_json 은 더 이상 상시 갱신되지 않으므로 여기서 ydoc 을 풀어
 * 그 시점의 블록을 만들어 넣는다. 이쪽이 항상 최신이다.
 */
export async function snapshotVersion(actor: Actor, pageId: string): Promise<void> {
  await assertCanEdit(actor.userId, pageId)
  const [page] = await db
    .select({ title: pages.title, ydoc: pages.ydoc, contentJson: pages.contentJson })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!page) throw new NotFound('Page')
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
async function replaceOutgoingLinks(ex: Executor, fromPageId: string, toIds: string[]): Promise<void> {
  const targets = [...new Set(toIds)].filter((id) => id && id !== fromPageId)

  await ex.delete(pageLinks).where(eq(pageLinks.fromPageId, fromPageId))
  if (targets.length === 0) return

  const alive = await ex
    .select({ id: pages.id })
    .from(pages)
    .where(inArray(pages.id, targets))

  if (alive.length === 0) return
  await ex.insert(pageLinks)
    .values(alive.map((p) => ({ fromPageId, toPageId: p.id })))
    .onConflictDoNothing()
}

export type Backlink = { id: string; title: string; icon: PageRow['icon'] }

/** 이 페이지를 본문에서 가리키는 페이지들 */
export async function listBacklinks(actor: Actor, pageId: string): Promise<Backlink[]> {
  const access = await assertCanRead(actor.userId, pageId)

  return db
    .select({ id: pages.id, title: pages.title, icon: pages.icon })
    .from(pageLinks)
    .innerJoin(pages, eq(pages.id, pageLinks.fromPageId))
    .where(and(
      eq(pageLinks.toPageId, pageId),
      eq(pages.isTrashed, false),
      // 이 페이지를 공유받은 게스트에게, 자기가 못 보는 문서의 제목이 새지 않게
      access.role === 'guest' ? readableByGuest(actor.userId, pages) : undefined,
    ))
    .orderBy(asc(pages.title))
    .limit(50)
}

/** 스냅샷 최소 간격. 자동저장은 몇 초마다 도는데 그때마다 찍으면 버전이 수천 개가 된다. */
const VERSION_MIN_GAP_MS = 10 * 60 * 1000

/** 마지막 스냅샷이 충분히 오래됐는지 (또는 아직 하나도 없는지) */
async function versionIsDue(ex: Executor, pageId: string): Promise<boolean> {
  const [last] = await ex
    .select({ createdAt: pageVersions.createdAt })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.createdAt))
    .limit(1)
  return !last || Date.now() - last.createdAt.getTime() >= VERSION_MIN_GAP_MS
}

export type PageVersionMeta = {
  id: string
  title: string
  authorId: string | null
  authorName: string | null
  createdAt: Date
}

/**
 * applyYdocUpdate 가 "때가 됐다" 고 돌려준 **저장 직전** 상태를 버전으로 남긴다.
 *
 * 결과적으로 "편집을 시작하기 직전 상태" 가 남는다 — 되돌릴 때 원하는 게 정확히 그것이다.
 * 예전에는 클라이언트가 저장 직전에 따로 부르고 "서버 액션은 순서대로 간다" 는 성질에
 * 순서를 맡겼다. 저장이 라우트 핸들러로 옮겨 가면서 그 보장이 사라져서, 저장 쪽이
 * 직전 상태를 직접 넘긴다.
 *
 * 두 저장이 거의 동시에 "때가 됐다" 고 봤을 수 있으므로, 잠금을 쥐고 한 번 더 확인한 뒤 넣는다
 * (잠금이 없으면 확인과 넣기 사이의 틈으로 둘 다 들어간다).
 */
export async function recordVersionSnapshot(
  actor: Actor,
  pageId: string,
  snapshot: { ydoc: Uint8Array; title: string },
): Promise<boolean> {
  await assertCanEdit(actor.userId, pageId)

  const { ydocBytesToBlocks } = await import('./markdown')
  const blocks = await ydocBytesToBlocks(snapshot.ydoc)
  const gapSeconds = VERSION_MIN_GAP_MS / 1000

  // 확인과 넣기 사이에 다른 저장이 끼지 않게 페이지 단위로 줄 세운다
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(xactLock('pageVersion', pageId))
    return tx.execute(sql`
      INSERT INTO page_versions (page_id, title, content_json, author_id)
      SELECT ${pageId}, ${snapshot.title}, ${JSON.stringify(blocks)}::jsonb, ${actor.userId}
       WHERE NOT EXISTS (
         SELECT 1 FROM page_versions
          WHERE page_id = ${pageId}
            AND created_at > now() - make_interval(secs => ${gapSeconds})
       )
      RETURNING id
    `)
  })
  return (inserted as unknown as unknown[]).length > 0
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
 * ★ ydoc 에 CRDT 변경으로 얹는다(applyYdocUpdate). 지금 문서 위에 "스냅샷 모양으로
 *   바꾸는 편집" 을 하는 셈이라, 열어 둔 다른 사람의 저장이 되돌리기를 지우지 못한다.
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

  const [current] = await db
    .select({ ydoc: pages.ydoc })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  if (!current) throw new NotFound('Page')
  const { applyBlocks } = await import('./markdown')

  // 예전에 NULL 로 저장된 버전이 남아 있을 수 있다
  const snapshot = Array.isArray(version.contentJson) && version.contentJson.length > 0
    ? version.contentJson
    : EMPTY_DOC

  const applied = await applyBlocks(current.ydoc, snapshot)
  await applyYdocUpdate(actor, pageId, applied.delta, { title: version.title })

  await audit.record(actor, 'page.restore_version', {
    workspaceId: access.workspaceId,
    targetId: pageId,
    meta: { versionId, versionCreatedAt: version.createdAt.toISOString() },
  })
}
