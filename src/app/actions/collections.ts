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
 *
 * 행 목록 다시 읽기는 조회라 라우트다 — app/api/collections/[collectionId]/rows
 */
import { z } from 'zod'
import { requireActor } from '@/lib/auth'
import * as Collections from '@/lib/core/collections'
import * as Pages from '@/lib/core/pages'
import { PROPERTY_TYPES, VIEW_TYPES } from '@/lib/core/schema'
import type { PropertyDef, PropertyType, ViewType } from '@/lib/core/schema'
import type {
  Collection, CollectionRowData, CollectionViewRow, ViewConfig,
} from '@/lib/core/collections'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

export type CollectionPayload = {
  collection: Collection
  views: CollectionViewRow[]
  schema: PropertyDef[]
  rows: CollectionRowData[]
  truncated: boolean
  activeViewId: string
}

const Name = z.string().max(200, '이름이 너무 깁니다')
const Title = z.string().max(1000, '제목이 너무 깁니다')
/** 속성값·뷰 설정은 모양이 타입마다 달라서 여기서는 "문자열 키의 객체" 까지만 본다. 의미는 core 가 본다 */
const Record_ = z.record(z.string(), z.unknown())

// ─────────────────────────────────────────── 컬렉션

export async function createCollection(pageId: string): Promise<ActionResult<CollectionPayload>> {
  return run('collections', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    const { collection, views } = await Collections.createCollection(actor, { pageId: id })
    const { schema, rows, truncated } = await Collections.listRows(actor, collection.id, {
      viewId: views[0].id,
    })
    return { collection, views, schema, rows, truncated, activeViewId: views[0].id }
  })
}

// ─────────────────────────────────────────── 행

export async function createRow(
  collectionId: string,
  input: { title?: string; properties?: Record<string, unknown> } = {},
): Promise<ActionResult<CollectionRowData>> {
  return run('collections', async () => {
    const id = parse(Id, collectionId)
    const valid = parse(z.object({ title: Title.optional(), properties: Record_.optional() }), input)
    const actor = await requireActor()
    return Collections.createRow(actor, id, valid)
  })
}

export async function updateRowProperties(
  pageId: string,
  patch: Record<string, unknown>,
): Promise<ActionResult<CollectionRowData>> {
  return run('collections', async () => {
    const id = parse(Id, pageId)
    const valid = parse(Record_, patch)
    const actor = await requireActor()
    return Collections.updateRowProperties(actor, id, valid)
  })
}

/**
 * 행 제목 수정. actions/pages.ts 의 renamePage 와 달리 revalidate 하지 않는다 —
 * 행은 사이드바에 없으므로 라우트를 다시 그릴 이유가 없다.
 */
export async function renameRow(pageId: string, title: string): Promise<ActionResult<null>> {
  return run('collections', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    await Pages.updatePageMeta(actor, id, { title: parse(Title, title) })
    return null
  })
}

export async function trashRow(pageId: string): Promise<ActionResult<null>> {
  return run('collections', async () => {
    const id = parse(Id, pageId)
    const actor = await requireActor()
    await Pages.trashPage(actor, id)
    return null
  })
}

// ─────────────────────────────────────────── 속성

export async function addProperty(
  collectionId: string,
  input: { name: string; type: PropertyType },
): Promise<ActionResult<PropertyDef>> {
  return run('collections', async () => {
    const id = parse(Id, collectionId)
    const valid = parse(z.object({ name: Name, type: z.enum(PROPERTY_TYPES) }), input)
    const actor = await requireActor()
    return Collections.addProperty(actor, id, valid)
  })
}

export async function updateProperty(
  collectionId: string,
  propId: string,
  patch: { name?: string; config?: Record<string, unknown> },
): Promise<ActionResult<PropertyDef>> {
  return run('collections', async () => {
    const id = parse(Id, collectionId)
    const prop = parse(Id, propId)
    const valid = parse(z.object({ name: Name.optional(), config: Record_.optional() }), patch)
    const actor = await requireActor()
    return Collections.updateProperty(actor, id, prop, valid)
  })
}

/**
 * 선택지 추가. 셀에서 처음 쓴 값을 속성의 선택지 목록에 등록한다.
 * config 를 통째로 갈아끼우는 updateProperty 와 달리 **없는 것만 덧붙인다** —
 * 두 사람이 동시에 새 태그를 쓰면 한쪽 태그가 사라지던 문제 때문이다.
 */
export async function addSelectOptions(
  collectionId: string,
  propId: string,
  names: string[],
): Promise<ActionResult<PropertyDef>> {
  return run('collections', async () => {
    const id = parse(Id, collectionId)
    const prop = parse(Id, propId)
    const valid = parse(z.array(z.string().min(1).max(200)).min(1).max(50), names)
    const actor = await requireActor()
    return Collections.addSelectOptions(actor, id, prop, valid)
  })
}

export async function deleteProperty(
  collectionId: string,
  propId: string,
): Promise<ActionResult<null>> {
  return run('collections', async () => {
    const id = parse(Id, collectionId)
    const prop = parse(Id, propId)
    const actor = await requireActor()
    await Collections.deleteProperty(actor, id, prop)
    return null
  })
}

// ─────────────────────────────────────────── 뷰

export async function createView(
  collectionId: string,
  input: { type: ViewType; name?: string },
): Promise<ActionResult<CollectionViewRow>> {
  return run('collections', async () => {
    const id = parse(Id, collectionId)
    const valid = parse(z.object({ type: z.enum(VIEW_TYPES), name: Name.optional() }), input)
    const actor = await requireActor()
    return Collections.createView(actor, id, valid)
  })
}

export async function updateView(
  viewId: string,
  patch: { name?: string; config?: ViewConfig },
): Promise<ActionResult<CollectionViewRow>> {
  return run('collections', async () => {
    const id = parse(Id, viewId)
    const valid = parse(z.object({ name: Name.optional(), config: Record_.optional() }), patch)
    const actor = await requireActor()
    return Collections.updateView(actor, id, {
      ...(valid.name !== undefined ? { name: valid.name } : {}),
      ...(valid.config !== undefined ? { config: valid.config as ViewConfig } : {}),
    })
  })
}

export async function deleteView(viewId: string): Promise<ActionResult<null>> {
  return run('collections', async () => {
    const id = parse(Id, viewId)
    const actor = await requireActor()
    await Collections.deleteView(actor, id)
    return null
  })
}
