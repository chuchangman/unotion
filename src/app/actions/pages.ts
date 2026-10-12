'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/auth'
import * as Pages from '@/lib/core/pages'
import * as Content from '@/lib/core/page-content'
import type { PageRow } from '@/lib/core/pages'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

/**
 * 웹 UI 어댑터. 로직은 없다 — lib/core 를 호출하고 결과를 직렬화만 한다.
 * MCP 서버도 같은 lib/core 를 호출한다. 로직이 여기 들어가면 둘이 갈라진다.
 *
 * 쓰기만 여기 있다. 조회는 라우트 핸들러다 (app/api/…) — 서버 액션은 클라이언트당
 * 한 줄로 서서, 조회를 여기 두면 쓰기 뒤에서 기다린다.
 * 본문(ydoc) 읽기·저장도 라우트다 — app/api/pages/[pageId]/ydoc/route.ts
 */

const Title = z.string().max(1000, '제목이 너무 깁니다')

// ─────────────────────────────────── 트리 / CRUD

export async function createPage(input: {
  workspaceId: string
  parentId?: string | null
  title?: string
}): Promise<ActionResult<{ id: string }>> {
  return run('pages', async () => {
    const valid = parse(z.object({
      workspaceId: Id,
      parentId: Id.nullable().optional(),
      title: Title.optional(),
    }), input)
    const actor = await requireActor()
    const page = await Pages.createPage(actor, valid)
    revalidatePath('/', 'layout')
    return { id: page.id }
  })
}

/**
 * 제목 저장.
 *
 * ★ 여기서는 revalidatePath 를 부르지 않는다.
 *   이 액션은 제목을 치는 동안 600ms 마다 호출되는데,
 *   `revalidatePath('/', 'layout')` 은 **앱 전체의 클라이언트 캐시를 날린다.**
 *   타이핑 중에 그걸 반복하면 사이드바 트리가 계속 다시 조회·렌더되고,
 *   staleTimes 로 켜 둔 캐시도 매번 무의미해진다.
 *
 *   화면에 보이는 제목은 PageHeader 의 로컬 상태가 이미 즉시 반영하고,
 *   사이드바는 입력이 끝났을 때(포커스 해제) PageHeader 가 한 번 refresh 한다.
 */
export async function renamePage(
  pageId: string,
  title: string,
  /** 입력을 마쳤을 때(포커스 해제) true. 이때만 감사 로그에 남긴다 */
  commit = false,
): Promise<ActionResult<null>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    await Pages.updatePageMeta(actor, id, { title: parse(Title, title) }, { audit: parse(z.boolean(), commit) })
    return null
  })
}

export async function setPageIcon(
  pageId: string,
  emoji: string | null,
): Promise<ActionResult<null>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    // 이모지 하나. 합자(가족·피부색)는 코드 단위로 열 개 넘게 길어진다
    const value = parse(z.string().min(1).max(32).nullable(), emoji)
    const actor = await requireActor()
    await Pages.updatePageMeta(actor, id, {
      icon: value ? { type: 'emoji', value } : null,
    })
    revalidatePath('/', 'layout')
    return null
  })
}

export async function movePage(
  pageId: string,
  target: { parentId: string | null; afterId?: string | null; beforeId?: string | null },
): Promise<ActionResult<null>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    const valid = parse(z.object({
      parentId: Id.nullable(),
      afterId: Id.nullable().optional(),
      beforeId: Id.nullable().optional(),
    }), target)
    const actor = await requireActor()
    await Pages.movePage(actor, id, valid)
    revalidatePath('/', 'layout')
    return null
  })
}

export async function trashPage(pageId: string): Promise<ActionResult<null>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    await Pages.trashPage(actor, id)
    revalidatePath('/', 'layout')
    return null
  })
}

// ─────────────────────────────────── 버전 기록

export async function listVersions(
  pageId: string,
): Promise<ActionResult<Content.PageVersionMeta[]>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    return Content.listVersions(actor, id)
  })
}

export async function restoreVersion(
  pageId: string,
  versionId: string,
): Promise<ActionResult<null>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    const version = parse(Id, versionId)
    const actor = await requireActor()
    await Content.restoreVersion(actor, id, version)
    revalidatePath('/', 'layout')
    return null
  })
}

// ─────────────────────────────────── 휴지통

export async function restorePage(pageId: string): Promise<ActionResult<null>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    await Pages.restorePage(actor, id)
    // 사이드바 트리에 다시 나타나야 한다
    revalidatePath('/', 'layout')
    return null
  })
}

export async function deletePagePermanently(pageId: string): Promise<ActionResult<null>> {
  return run('pages', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    await Pages.deletePagePermanently(actor, id)
    revalidatePath('/', 'layout')
    return null
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
  return run('pages', async () => {
    const valid = parse(z.object({ workspaceId: Id, parentId: Id, title: Title }), input)
    const actor = await requireActor()
    const page = await Pages.createPage(actor, {
      ...valid,
      icon: { type: 'emoji', value: '📄' },
    })
    revalidatePath('/', 'layout')
    return { id: page.id, title: page.title, icon: page.icon }
  })
}
