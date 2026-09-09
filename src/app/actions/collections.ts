'use server'

/**
 * 데이터베이스(컬렉션) 웹 어댑터. 로직은 없다 — lib/core/collections 를 부르고
 * 결과를 직렬화만 한다.
 *
 * ★ revalidatePath 를 거의 쓰지 않는다.
 *   Next 16 은 서버 액션을 **클라이언트당 순차 디스패치**하고, revalidate 가 붙으면
 *   응답에 라우트 재렌더까지 실려 온다. 셀 하나 고칠 때마다 그러면 표가 버벅인다.
 *   행은 사이드바 트리에도 안 나온다(getPageTree 가 collection_id IS NULL 로 거른다).
 *   그래서 표의 변경은 응답값으로만 돌려주고 화면은 클라이언트 상태로 갱신한다.
 */
import { requireActor } from '@/lib/auth'
import * as Collections from '@/lib/core/collections'
import * as Pages from '@/lib/core/pages'
import { DomainError } from '@/lib/core/errors'
import type { PropertyDef, PropertyType, ViewType } from '@/lib/core/schema'
import type {
  Collection, CollectionRowData, CollectionViewRow, ViewConfig,
} from '@/lib/core/collections'

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
    console.error('[action:collections] 예상치 못한 오류', err)
    return { ok: false, code: 'internal', message: '알 수 없는 오류가 발생했습니다' }
  }
}

export type CollectionPayload = {
  collection: Collection
  views: CollectionViewRow[]
  schema: PropertyDef[]
  rows: CollectionRowData[]
  truncated: boolean
  activeViewId: string
}

// ─────────────────────────────────────────── 컬렉션

export async function createCollection(pageId: string): Promise<ActionResult<CollectionPayload>> {
  return run(async () => {
    const actor = await requireActor()
    const { collection, views } = await Collections.createCollection(actor, { pageId })
    const { schema, rows, truncated } = await Collections.listRows(actor, collection.id, {
      viewId: views[0].id,
    })
    return { collection, views, schema, rows, truncated, activeViewId: views[0].id }
  })
}

/** 렌더에 필요한 걸 한 번에. 뷰를 지정하지 않으면 첫 뷰를 쓴다. */
export async function getCollectionPayload(
  pageId: string,
  viewId?: string,
): Promise<ActionResult<CollectionPayload | null>> {
  return run(async () => {
    const actor = await requireActor()
    const found = await Collections.getCollectionForPage(actor, pageId)
    if (!found) return null

    const { collection, views } = found
    const activeViewId = views.find((v) => v.id === viewId)?.id ?? views[0]?.id
    const { schema, rows, truncated } = await Collections.listRows(actor, collection.id, {
      viewId: activeViewId,
    })
    return { collection, views, schema, rows, truncated, activeViewId }
  })
}

export async function listRows(
  collectionId: string,
  viewId: string,
): Promise<ActionResult<{ rows: CollectionRowData[]; truncated: boolean }>> {
  return run(async () => {
    const actor = await requireActor()
    const { rows, truncated } = await Collections.listRows(actor, collectionId, { viewId })
    return { rows, truncated }
  })
}

// ─────────────────────────────────────────── 행

export async function createRow(
  collectionId: string,
  input: { title?: string; properties?: Record<string, unknown> } = {},
): Promise<ActionResult<CollectionRowData>> {
  return run(async () => {
    const actor = await requireActor()
    return Collections.createRow(actor, collectionId, input)
  })
}

export async function updateRowProperties(
  pageId: string,
  patch: Record<string, unknown>,
): Promise<ActionResult<CollectionRowData>> {
  return run(async () => {
    const actor = await requireActor()
    return Collections.updateRowProperties(actor, pageId, patch)
  })
}

/**
 * 행 제목 수정. actions/pages.ts 의 renamePage 와 달리 revalidate 하지 않는다 —
 * 행은 사이드바에 없으므로 라우트를 다시 그릴 이유가 없다.
 */
export async function renameRow(pageId: string, title: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.updatePageMeta(actor, pageId, { title })
    return null
  })
}

export async function trashRow(pageId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Pages.trashPage(actor, pageId)
    return null
  })
}

// ─────────────────────────────────────────── 속성

export async function addProperty(
  collectionId: string,
  input: { name: string; type: PropertyType },
): Promise<ActionResult<PropertyDef>> {
  return run(async () => {
    const actor = await requireActor()
    return Collections.addProperty(actor, collectionId, input)
  })
}

export async function updateProperty(
  collectionId: string,
  propId: string,
  patch: { name?: string; config?: Record<string, unknown> },
): Promise<ActionResult<PropertyDef>> {
  return run(async () => {
    const actor = await requireActor()
    return Collections.updateProperty(actor, collectionId, propId, patch)
  })
}

export async function deleteProperty(
  collectionId: string,
  propId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Collections.deleteProperty(actor, collectionId, propId)
    return null
  })
}

// ─────────────────────────────────────────── 뷰

export async function createView(
  collectionId: string,
  input: { type: ViewType; name?: string },
): Promise<ActionResult<CollectionViewRow>> {
  return run(async () => {
    const actor = await requireActor()
    return Collections.createView(actor, collectionId, input)
  })
}

export async function updateView(
  viewId: string,
  patch: { name?: string; config?: ViewConfig },
): Promise<ActionResult<CollectionViewRow>> {
  return run(async () => {
    const actor = await requireActor()
    return Collections.updateView(actor, viewId, patch)
  })
}

export async function deleteView(viewId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Collections.deleteView(actor, viewId)
    return null
  })
}
