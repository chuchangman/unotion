/**
 * 데이터베이스(컬렉션) 도메인. 노션의 "데이터베이스"에 해당한다.
 *
 * 모델:
 *   - 컬렉션 하나는 **호스트 페이지 하나**에 붙는다 (collections.pageId).
 *     즉 "이 페이지는 문서가 아니라 표다".
 *   - 행(row)은 **진짜 페이지**다. pages.collectionId 가 채워지고
 *     parentId 는 호스트 페이지다. 그래서 행을 클릭하면 그냥 문서로 열린다.
 *   - 행의 속성값은 pages.properties 에 { [propId]: value } 로 들어간다.
 *
 * 권한: 컬렉션/뷰/스키마 변경은 **호스트 페이지**의 edit 권한을 본다.
 *       행 자체의 변경은 그 행 페이지의 권한을 본다 (pages.ts 가 이미 한다).
 *
 * 규칙은 pages.ts 와 같다 — 모든 export 함수는 첫 인자로 Actor 를 받고
 * 가장 먼저 assert* 를 호출한다.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { generateKeyBetween } from 'fractional-indexing'
import { db } from './db'
import { collections, collectionViews, pages } from './schema'
import type { PropertyDef, PropertyType, ViewType } from './schema'
import { InvalidInput, NotFound } from './errors'
import { assertCanEdit, assertCanRead } from './permissions'
import * as audit from './audit'
import * as Pages from './pages'
import type { Actor } from './actor'
import {
  applyView, isDerived as isDerivedType,
  type CollectionRowData, type ViewConfig,
} from '@/lib/collection-query'

export type Collection = typeof collections.$inferSelect
export type CollectionViewRow = typeof collectionViews.$inferSelect

/**
 * 값 해석·필터·정렬·그룹 규칙은 lib/collection-query.ts 하나에만 둔다.
 * 클라이언트도 같은 파일을 쓰므로 표에 보이는 값과 서버가 거른 값이 갈라지지 않는다.
 */
export type {
  CollectionRowData, Filter, FilterOp, Sort, ViewConfig, SelectOption, DateValue,
} from '@/lib/collection-query'
export { isDerived, valueOf, groupRows } from '@/lib/collection-query'

/** 아직 질의/UI 를 구현하지 않은 타입. 스키마에 들어오는 것 자체를 막는다. */
const UNSUPPORTED: ReadonlySet<PropertyType> = new Set(['relation', 'rollup', 'formula', 'files'])

// ─────────────────────────────────────────── 로드 헬퍼

async function loadCollection(collectionId: string): Promise<Collection> {
  const [row] = await db.select().from(collections).where(eq(collections.id, collectionId)).limit(1)
  if (!row) throw new NotFound('Collection')
  return row
}

/** 컬렉션 변경 권한 = 호스트 페이지의 edit 권한 */
async function assertCanEditCollection(actor: Actor, collectionId: string) {
  const collection = await loadCollection(collectionId)
  await assertCanEdit(actor.userId, collection.pageId)
  return collection
}

async function assertCanReadCollection(actor: Actor, collectionId: string) {
  const collection = await loadCollection(collectionId)
  await assertCanRead(actor.userId, collection.pageId)
  return collection
}

async function nextViewSortKey(collectionId: string): Promise<string> {
  const rows = await db
    .select({ sortKey: collectionViews.sortKey })
    .from(collectionViews)
    .where(eq(collectionViews.collectionId, collectionId))
    .orderBy(asc(collectionViews.sortKey))
  return generateKeyBetween(rows.at(-1)?.sortKey ?? null, null)
}

// ─────────────────────────────────────────── 컬렉션

/**
 * 페이지를 데이터베이스로 만든다.
 * 기본 스키마(이름 / 태그 / 날짜)와 기본 표 뷰를 함께 만든다 —
 * 완전히 빈 표는 사용자가 뭘 해야 할지 모른다.
 */
export async function createCollection(
  actor: Actor,
  input: { pageId: string; name?: string },
): Promise<{ collection: Collection; views: CollectionViewRow[] }> {
  const access = await assertCanEdit(actor.userId, input.pageId)

  const existing = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.pageId, input.pageId))
    .limit(1)
  if (existing.length) throw new InvalidInput('이미 데이터베이스인 페이지입니다')

  const schema: PropertyDef[] = [
    { id: randomUUID(), name: '이름', type: 'title' },
    { id: randomUUID(), name: '태그', type: 'select', config: { options: [] } },
    { id: randomUUID(), name: '날짜', type: 'date' },
  ]

  const [collection] = await db.insert(collections).values({
    workspaceId: access.workspaceId,
    pageId: input.pageId,
    name: input.name ?? '',
    schema,
  }).returning()

  const [view] = await db.insert(collectionViews).values({
    collectionId: collection.id,
    type: 'table',
    name: '표',
    sortKey: generateKeyBetween(null, null),
    config: {},
  }).returning()

  await audit.record(actor, 'collection.create', {
    workspaceId: access.workspaceId, targetId: collection.id, meta: { pageId: input.pageId },
  })
  return { collection, views: [view] }
}

/** 이 페이지가 데이터베이스면 컬렉션과 뷰들을, 아니면 null */
export async function getCollectionForPage(
  actor: Actor,
  pageId: string,
): Promise<{ collection: Collection; views: CollectionViewRow[] } | null> {
  await assertCanRead(actor.userId, pageId)

  const [collection] = await db
    .select().from(collections).where(eq(collections.pageId, pageId)).limit(1)
  if (!collection) return null

  const views = await db
    .select().from(collectionViews)
    .where(eq(collectionViews.collectionId, collection.id))
    .orderBy(asc(collectionViews.sortKey))

  return { collection, views }
}

export async function renameCollection(
  actor: Actor, collectionId: string, name: string,
): Promise<Collection> {
  const collection = await assertCanEditCollection(actor, collectionId)
  const [row] = await db.update(collections)
    .set({ name }).where(eq(collections.id, collectionId)).returning()
  await audit.record(actor, 'collection.rename', {
    workspaceId: collection.workspaceId, targetId: collectionId, meta: { name },
  })
  return row
}

// ─────────────────────────────────────────── 속성(컬럼)

export async function addProperty(
  actor: Actor,
  collectionId: string,
  input: { name: string; type: PropertyType; config?: Record<string, unknown> },
): Promise<PropertyDef> {
  const collection = await assertCanEditCollection(actor, collectionId)

  if (UNSUPPORTED.has(input.type)) {
    throw new InvalidInput(`'${input.type}' 속성은 아직 지원하지 않습니다`)
  }
  if (input.type === 'title') {
    throw new InvalidInput('제목 속성은 하나뿐이며 새로 만들 수 없습니다')
  }

  const needsOptions =
    input.type === 'select' || input.type === 'multi_select' || input.type === 'status'

  const prop: PropertyDef = {
    id: randomUUID(),
    name: input.name.trim() || '속성',
    type: input.type,
    config: input.config ?? (needsOptions ? { options: [] } : undefined),
  }

  await db.update(collections)
    .set({ schema: [...collection.schema, prop] })
    .where(eq(collections.id, collectionId))

  await audit.record(actor, 'collection.add_property', {
    workspaceId: collection.workspaceId,
    targetId: collectionId,
    meta: { name: prop.name, type: prop.type },
  })
  return prop
}

export async function updateProperty(
  actor: Actor,
  collectionId: string,
  propId: string,
  patch: { name?: string; config?: Record<string, unknown> },
): Promise<PropertyDef> {
  const collection = await assertCanEditCollection(actor, collectionId)

  const idx = collection.schema.findIndex((p) => p.id === propId)
  if (idx < 0) throw new NotFound('Property')

  const next = [...collection.schema]
  next[idx] = {
    ...next[idx],
    ...(patch.name !== undefined ? { name: patch.name.trim() || next[idx].name } : {}),
    ...(patch.config !== undefined ? { config: patch.config } : {}),
  }

  await db.update(collections).set({ schema: next }).where(eq(collections.id, collectionId))
  await audit.record(actor, 'collection.update_property', {
    workspaceId: collection.workspaceId, targetId: collectionId, meta: { propId },
  })
  return next[idx]
}

/**
 * 속성을 지운다. **각 행의 값도 함께 지운다** —
 * 남겨두면 나중에 같은 자리에 속성을 다시 만들 때 유령 값이 되살아난다.
 * jsonb 의 `-` 연산자로 키 하나만 떼어낸다.
 */
export async function deleteProperty(
  actor: Actor, collectionId: string, propId: string,
): Promise<void> {
  const collection = await assertCanEditCollection(actor, collectionId)

  const prop = collection.schema.find((p) => p.id === propId)
  if (!prop) throw new NotFound('Property')
  if (prop.type === 'title') throw new InvalidInput('제목 속성은 지울 수 없습니다')

  await db.update(collections)
    .set({ schema: collection.schema.filter((p) => p.id !== propId) })
    .where(eq(collections.id, collectionId))

  if (!isDerivedType(prop.type)) {
    await db.update(pages)
      .set({ properties: sql`${pages.properties} - ${propId}` })
      .where(eq(pages.collectionId, collectionId))
  }

  await audit.record(actor, 'collection.delete_property', {
    workspaceId: collection.workspaceId,
    targetId: collectionId,
    meta: { propId, name: prop.name },
  })
}

// ─────────────────────────────────────────── 뷰

const DEFAULT_VIEW_NAME: Record<ViewType, string> = {
  table: '표', board: '보드', calendar: '캘린더', gallery: '갤러리', list: '목록',
}

export async function createView(
  actor: Actor,
  collectionId: string,
  input: { type: ViewType; name?: string },
): Promise<CollectionViewRow> {
  const collection = await assertCanEditCollection(actor, collectionId)

  /**
   * 보드는 그룹 기준이 없으면 한 칸짜리가 되어 쓸모가 없다.
   * 스키마의 첫 select/status 속성을 기본 그룹으로 잡아준다.
   */
  const config: ViewConfig = {}
  if (input.type === 'board') {
    const groupProp = collection.schema.find((p) => p.type === 'select' || p.type === 'status')
    if (groupProp) config.groupBy = groupProp.id
  }

  const [view] = await db.insert(collectionViews).values({
    collectionId,
    type: input.type,
    name: input.name?.trim() || DEFAULT_VIEW_NAME[input.type],
    sortKey: await nextViewSortKey(collectionId),
    config,
  }).returning()

  await audit.record(actor, 'collection.create_view', {
    workspaceId: collection.workspaceId, targetId: collectionId, meta: { type: input.type },
  })
  return view
}

export async function updateView(
  actor: Actor,
  viewId: string,
  patch: { name?: string; config?: ViewConfig },
): Promise<CollectionViewRow> {
  const [view] = await db.select().from(collectionViews)
    .where(eq(collectionViews.id, viewId)).limit(1)
  if (!view) throw new NotFound('View')
  const collection = await assertCanEditCollection(actor, view.collectionId)

  const [row] = await db.update(collectionViews)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() || view.name } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
    })
    .where(eq(collectionViews.id, viewId))
    .returning()

  await audit.record(actor, 'collection.update_view', {
    workspaceId: collection.workspaceId, targetId: view.collectionId, meta: { viewId },
  })
  return row
}

export async function deleteView(actor: Actor, viewId: string): Promise<void> {
  const [view] = await db.select().from(collectionViews)
    .where(eq(collectionViews.id, viewId)).limit(1)
  if (!view) throw new NotFound('View')
  const collection = await assertCanEditCollection(actor, view.collectionId)

  const remaining = await db
    .select({ id: collectionViews.id })
    .from(collectionViews)
    .where(eq(collectionViews.collectionId, view.collectionId))
  if (remaining.length <= 1) throw new InvalidInput('마지막 뷰는 지울 수 없습니다')

  await db.delete(collectionViews).where(eq(collectionViews.id, viewId))
  await audit.record(actor, 'collection.delete_view', {
    workspaceId: collection.workspaceId, targetId: view.collectionId, meta: { viewId },
  })
}

// ─────────────────────────────────────────── 행

/** 한 번에 읽어오는 행 수 상한 (5인 팀 위키 규모 전제) */
export const ROW_LIMIT = 1000

export async function createRow(
  actor: Actor,
  collectionId: string,
  input: { title?: string; properties?: Record<string, unknown> } = {},
): Promise<CollectionRowData> {
  const collection = await assertCanEditCollection(actor, collectionId)

  const page = await Pages.createPage(actor, {
    workspaceId: collection.workspaceId,
    parentId: collection.pageId,
    title: input.title ?? '',
    collectionId,
    properties: input.properties ?? {},
  })

  return toRowData(page)
}

export async function updateRowProperties(
  actor: Actor,
  pageId: string,
  patch: Record<string, unknown>,
): Promise<CollectionRowData> {
  const access = await assertCanEdit(actor.userId, pageId)

  const [current] = await db
    .select({ properties: pages.properties, collectionId: pages.collectionId })
    .from(pages).where(eq(pages.id, pageId)).limit(1)
  if (!current) throw new NotFound('Page')
  if (!current.collectionId) throw new InvalidInput('데이터베이스의 행이 아닙니다')

  // null / undefined 로 온 키는 "값 지우기"로 해석한다
  const merged: Record<string, unknown> = { ...(current.properties as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete merged[k]
    else merged[k] = v
  }

  const [row] = await db.update(pages)
    .set({ properties: merged, lastEditedBy: actor.userId, updatedAt: new Date() })
    .where(eq(pages.id, pageId))
    .returning()

  await audit.record(actor, 'collection.update_row', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { keys: Object.keys(patch) },
  })
  return toRowData(row)
}

function toRowData(p: {
  id: string
  title: string
  icon: unknown
  properties: unknown
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
  lastEditedBy: string | null
}): CollectionRowData {
  return {
    id: p.id,
    title: p.title,
    icon: (p.icon ?? null) as CollectionRowData['icon'],
    properties: (p.properties ?? {}) as Record<string, unknown>,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    createdBy: p.createdBy,
    lastEditedBy: p.lastEditedBy,
  }
}

// ─────────────────────────────────────────── 질의 (필터 / 정렬 / 그룹)

/**
 * 필터·정렬은 **메모리에서** 한다.
 *
 * 속성값이 jsonb 안에 있어 SQL 로 하려면 타입별 캐스팅과 전용 인덱스가 필요한데,
 * 5인 팀 위키의 한 데이터베이스는 많아야 수백 행이다. 그 규모에서는
 * 전부 읽어와 JS 에서 거르는 편이 정확하고 단순하다.
 * ROW_LIMIT 을 넘길 만큼 커지면 그때가 SQL 로 내릴 신호다 (truncated 로 알려준다).
 */
export async function listRows(
  actor: Actor,
  collectionId: string,
  opts: { viewId?: string } = {},
): Promise<{
  schema: PropertyDef[]
  view: CollectionViewRow | null
  rows: CollectionRowData[]
  truncated: boolean
}> {
  const collection = await assertCanReadCollection(actor, collectionId)

  let view: CollectionViewRow | null = null
  if (opts.viewId) {
    const [v] = await db.select().from(collectionViews)
      .where(and(
        eq(collectionViews.id, opts.viewId),
        eq(collectionViews.collectionId, collectionId),
      ))
      .limit(1)
    view = v ?? null
  }

  const raw = await db
    .select({
      id: pages.id,
      title: pages.title,
      icon: pages.icon,
      properties: pages.properties,
      createdAt: pages.createdAt,
      updatedAt: pages.updatedAt,
      createdBy: pages.createdBy,
      lastEditedBy: pages.lastEditedBy,
    })
    .from(pages)
    .where(and(eq(pages.collectionId, collectionId), eq(pages.isTrashed, false)))
    .orderBy(asc(pages.sortKey))
    .limit(ROW_LIMIT + 1)

  const truncated = raw.length > ROW_LIMIT
  const rows = applyView(
    collection.schema,
    raw.slice(0, ROW_LIMIT).map(toRowData),
    (view?.config ?? {}) as ViewConfig,
  )

  return { schema: collection.schema, view, rows, truncated }
}
