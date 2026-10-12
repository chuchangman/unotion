/**
 * 데이터베이스(컬렉션)의 JSONB 갱신이 "DB 에 있는 값 위에서" 일어나는지 확인한다.
 *
 * 예전에는 속성값과 스키마를 읽어 JS 에서 합친 뒤 통째로 썼다. 두 사람이 같은 행의 다른 칸을,
 * 또는 같은 속성에 서로 다른 새 태그를 동시에 쓰면 나중 쪽이 먼저 쓴 것을 지웠다.
 * 여기서는 "읽어 둔 옛 값" 을 가진 두 요청이 순서대로 들어오는 상황을 그대로 재현한다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '@/lib/core/schema'
import type { Actor } from '@/lib/core/actor'
import type { SelectOption } from '@/lib/collection-query'
import { createTestDb, withRowArrays } from './setup'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/core/db', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
}))

const OWNER = '11111111-1111-4111-8111-111111111111'
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOST = 'bbbbbbbb-0000-4000-8000-000000000001'
const owner: Actor = { userId: OWNER, source: 'web' }

let pg: PGlite
let Collections: typeof import('@/lib/core/collections')
let collectionId = ''

beforeAll(async () => {
  pg = await createTestDb()
  holder.db = withRowArrays(drizzle(pg, { schema }))
  await pg.exec(`
    INSERT INTO auth.users VALUES ('${OWNER}');
    INSERT INTO profiles (id, email, display_name) VALUES ('${OWNER}', 'o@x', 'o');
    INSERT INTO workspaces (id, name, owner_id) VALUES ('${WS}', 'w', '${OWNER}');
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('${WS}', '${OWNER}', 'owner');
    INSERT INTO pages (id, workspace_id, parent_id, path, sort_key, title)
      VALUES ('${HOST}', '${WS}', NULL, '/', 'a0', '할 일');
  `)
  Collections = await import('@/lib/core/collections')
  collectionId = (await Collections.createCollection(owner, { pageId: HOST })).collection.id
}, 60_000)

afterAll(async () => {
  await pg?.close()
})

const schemaOf = async () => (await Collections.getCollectionForPage(owner, HOST))!.collection.schema

describe('행 속성', () => {
  it('회귀: 같은 행의 다른 칸을 연달아 고쳐도 앞의 값이 살아 있다', async () => {
    const [tag, date] = (await schemaOf()).filter((p) => p.type !== 'title')
    const row = await Collections.createRow(owner, collectionId)

    await Collections.updateRowProperties(owner, row.id, { [tag.id]: '급함' })
    // 두 번째 요청은 첫 번째가 쓰기 전의 행을 보고 만들어졌다 — 그래도 첫 값이 남아야 한다
    const after = await Collections.updateRowProperties(owner, row.id, { [date.id]: { start: '2026-10-01' } })

    expect(after.properties).toEqual({ [tag.id]: '급함', [date.id]: { start: '2026-10-01' } })
  })

  it('null 은 그 칸만 지운다', async () => {
    const [tag, date] = (await schemaOf()).filter((p) => p.type !== 'title')
    const row = await Collections.createRow(owner, collectionId, {
      properties: { [tag.id]: '보통', [date.id]: { start: '2026-10-02' } },
    })
    const after = await Collections.updateRowProperties(owner, row.id, { [tag.id]: null })
    expect(after.properties).toEqual({ [date.id]: { start: '2026-10-02' } })
  })

  it('행이 아닌 페이지는 거부한다', async () => {
    await expect(Collections.updateRowProperties(owner, HOST, { x: 1 })).rejects.toThrow(/행이 아닙니다/)
  })
})

describe('스키마', () => {
  it('회귀: 서로 다른 새 태그를 연달아 등록해도 둘 다 남는다', async () => {
    const tag = (await schemaOf()).find((p) => p.type === 'select')!
    await Collections.addSelectOptions(owner, collectionId, tag.id, ['디자인'])
    await Collections.addSelectOptions(owner, collectionId, tag.id, ['개발', '디자인']) // 디자인은 이미 있다

    const options = ((await schemaOf()).find((p) => p.id === tag.id)!.config!.options as SelectOption[])
    expect(options.map((o) => o.name)).toEqual(['디자인', '개발'])
  })

  it('속성 추가·이름 변경·삭제가 다른 속성을 건드리지 않는다', async () => {
    const before = await schemaOf()
    const added = await Collections.addProperty(owner, collectionId, { name: '담당', type: 'person' })
    await Collections.updateProperty(owner, collectionId, added.id, { name: '담당자' })
    await Collections.updateProperty(owner, collectionId, added.id, { name: '   ' }) // 빈 이름은 무시

    let now = await schemaOf()
    expect(now.find((p) => p.id === added.id)?.name).toBe('담당자')
    expect(now.slice(0, before.length)).toEqual(before) // 순서와 나머지가 그대로

    await Collections.deleteProperty(owner, collectionId, added.id)
    now = await schemaOf()
    expect(now).toEqual(before)
  })
})
