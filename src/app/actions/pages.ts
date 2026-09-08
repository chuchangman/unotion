'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/lib/auth'
import * as Pages from '@/lib/core/pages'
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

export async function savePage(
  pageId: string,
  input: { ydocB64: string; contentJson: unknown; plainText: string; title: string },
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.savePageContent(actor, pageId, {
      ydoc: Buffer.from(input.ydocB64, 'base64'),
      contentJson: input.contentJson,
      plainText: input.plainText,
      title: input.title,
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

export async function searchPages(
  workspaceId: string,
  query: string,
): Promise<ActionResult<Array<{ id: string; title: string; snippet: string }>>> {
  return run(async () => {
    const actor = await requireActor()
    return Pages.searchPages(actor, workspaceId, query)
  })
}
