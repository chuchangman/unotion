'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import * as Pages from '@/lib/core/pages'
import type { PageRow } from '@/lib/core/pages'
import { DomainError } from '@/lib/core/errors'

/**
 * 웹 UI 어댑터. 로직은 없다 — lib/core 를 호출하고 결과를 직렬화만 한다.
 * MCP 서버도 같은 lib/core 를 호출한다. 로직이 여기 들어가면 둘이 갈라진다.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, code: err.code, message: err.message }
    }
    console.error('[action] 예상치 못한 오류', err)
    return { ok: false, code: 'internal', message: '알 수 없는 오류가 발생했습니다' }
  }
}

// ─────────────────────────────────── ydoc (Yjs 프로바이더용)

/** bytea <-> base64. server action 경계에서는 문자열이 가장 안전하다. */
export async function loadYdoc(pageId: string): Promise<ActionResult<string | null>> {
  return run(async () => {
    const actor = await requireActor()
    const page = await Pages.getPage(actor, pageId)
    return page.ydoc ? Buffer.from(page.ydoc).toString('base64') : null
  })
}

/**
 * 에디터 자동저장.
 *
 * ydoc 만 보낸다. content_json 은 읽는 곳이 없는데도 같이 실려 보내지면서
 * 큰 문서의 저장 페이로드를 두 배로 만들고 있었다.
 */
export async function savePage(
  pageId: string,
  input: { ydocB64: string; plainText: string; title: string; links?: string[] },
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.savePageContent(actor, pageId, {
      ydoc: Buffer.from(input.ydocB64, 'base64'),
      plainText: input.plainText,
      title: input.title,
      // 링크는 바뀌었을 때만 실려 온다 (없으면 링크 테이블을 건드리지 않는다)
      ...(input.links !== undefined ? { links: input.links } : {}),
    })
    return null
  })
}

// ─────────────────────────────────── 트리 / CRUD

export async function createPage(input: {
  workspaceId: string
  parentId?: string | null
  title?: string
}): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const actor = await requireActor()
    const page = await Pages.createPage(actor, input)
    revalidatePath('/', 'layout')
    return { id: page.id }
  })
}

export async function renamePage(
  pageId: string,
  title: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.updatePageMeta(actor, pageId, { title })
    revalidatePath('/', 'layout')
    return null
  })
}

export async function setPageIcon(
  pageId: string,
  emoji: string | null,
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.updatePageMeta(actor, pageId, {
      icon: emoji ? { type: 'emoji', value: emoji } : null,
    })
    revalidatePath('/', 'layout')
    return null
  })
}

export async function movePage(
  pageId: string,
  target: { parentId: string | null; afterId?: string | null; beforeId?: string | null },
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.movePage(actor, pageId, target)
    revalidatePath('/', 'layout')
    return null
  })
}

export async function trashPage(pageId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.trashPage(actor, pageId)
    revalidatePath('/', 'layout')
    return null
  })
}

// ─────────────────────────────────── 버전 기록

export async function listVersions(
  pageId: string,
): Promise<ActionResult<Pages.PageVersionMeta[]>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.listVersions(actor, pageId)
  })
}

/**
 * 에디터가 저장 직전에 부른다. 간격이 짧으면 서버가 알아서 건너뛴다.
 * 저장 자체를 막지 않도록 실패해도 조용히 넘어간다 — 호출부에서 결과를 무시한다.
 */
export async function snapshotVersion(pageId: string): Promise<ActionResult<boolean>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.snapshotVersionIfStale(actor, pageId)
  })
}

export async function restoreVersion(
  pageId: string,
  versionId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.restoreVersion(actor, pageId, versionId)
    revalidatePath('/', 'layout')
    return null
  })
}

// ─────────────────────────────────── 휴지통

export async function listTrashed(
  workspaceId: string,
): Promise<ActionResult<Pages.TrashedPage[]>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.listTrashed(actor, workspaceId)
  })
}

export async function restorePage(pageId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.restorePage(actor, pageId)
    // 사이드바 트리에 다시 나타나야 한다
    revalidatePath('/', 'layout')
    return null
  })
}

export async function deletePagePermanently(pageId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.deletePagePermanently(actor, pageId)
    revalidatePath('/', 'layout')
    return null
  })
}

/** 우측 미리보기 패널이 페이지를 열 때 필요한 최소 정보 */
export async function getPagePreview(pageId: string): Promise<ActionResult<{
  id: string
  title: string
  icon: PageRow['icon']
  canEdit: boolean
}>> {
  return run(async () => {
    const actor = await requireActor()
    const page = await Pages.getPage(actor, pageId)
    const access = await Pages.resolvePageAccess(actor.userId, pageId, page)
    return {
      id: page.id,
      title: page.title,
      icon: page.icon,
      canEdit: access?.level === 'edit' || access?.level === 'full',
    }
  })
}

/** 특정 페이지의 바로 아래 자식들 (페이지 보드 블록이 쓴다) */
export async function listChildPages(parentId: string): Promise<ActionResult<
  Array<{ id: string; title: string; icon: PageRow['icon'] }>
>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.listChildren(actor, parentId)
  })
}

/** 페이지 보드가 모든 칸의 목록을 한 번에 가져온다 */
export async function listChildPagesBatch(parentIds: string[]): Promise<ActionResult<
  Record<string, Array<{ id: string; title: string; icon: PageRow['icon'] }>>
>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.listChildrenBatch(actor, parentIds)
  })
}

/** 본문에서 @ 로 페이지를 링크할 때 쓰는 검색 (아이콘 포함) */
export async function searchPagesForLink(
  workspaceId: string,
  query: string,
): Promise<ActionResult<Array<{ id: string; title: string; icon: PageRow['icon'] }>>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.searchPagesForLink(actor, workspaceId, query)
  })
}

/**
 * 본문에서 바로 하위 페이지를 만든다.
 * 링크에 넣을 정보(제목·아이콘)를 그대로 돌려준다.
 */
export async function createLinkedChildPage(input: {
  workspaceId: string
  parentId: string
  title: string
}): Promise<ActionResult<{ id: string; title: string; icon: PageRow['icon'] }>> {
  return run(async () => {
    const actor = await requireActor()
    const page = await Pages.createPage(actor, {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      title: input.title,
      icon: { type: 'emoji', value: '📄' },
    })
    revalidatePath('/', 'layout')
    return { id: page.id, title: page.title, icon: page.icon }
  })
}

export async function searchPages(
  workspaceId: string,
  query: string,
): Promise<ActionResult<Array<{ id: string; title: string; snippet: string }>>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.searchPages(actor, workspaceId, query)
  })
}

/**
 * 검색창을 막 열었을 때(검색어가 없을 때) 보여줄 최근 문서.
 * 빈 화면보다 낫다 — 실제로 찾는 문서의 상당수가 방금 보던 것이다.
 *
 * getRecentChanges 를 그대로 쓴다. "언제부터"가 아니라 "최근 N개"가 필요하므로
 * 시작점은 epoch 로 두고 정렬(updated_at DESC)과 limit 에 맡긴다.
 */
export async function recentPages(
  workspaceId: string,
  limit = 8,
): Promise<ActionResult<Array<{ id: string; title: string }>>> {
  return run(async () => {
    const actor = await requireActor()
    const rows = await Pages.getRecentChanges(actor, workspaceId, new Date(0), limit)
    return rows.map((r) => ({ id: r.id, title: r.title || '제목 없음' }))
  })
}
