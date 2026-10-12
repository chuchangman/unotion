/**
 * 본문의 유일한 쓰기 경로(applyYdocUpdate)와 읽기(loadYdocState)를 실제 Postgres(PGlite) 위에서.
 *
 * ydoc.test.ts 가 병합 규칙을 메모리에서 보지만, 여기서는 그 결과가 DB 에 어떻게 남는지를 본다 —
 * 열기만 한 저장이 수정 시각을 안 바꾸는지, 링크 표를 필요할 때만 다시 쓰는지, 버전 때를 맞게 알리는지.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '@/lib/core/schema'
import type { Actor } from '@/lib/core/actor'
import { FRAGMENT } from '@/lib/ydoc'
import { createTestDb, withRowArrays } from './setup'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/core/db', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
}))

const OWNER = '11111111-1111-4111-8111-111111111111'
const EDITOR = '33333333-3333-4333-8333-333333333333'
/** 멤버지만 이 문서에는 읽기만 */
const READER = '44444444-4444-4444-8444-444444444444'
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DOC = 'cccccccc-0000-4000-8000-000000000001'
const TARGET = 'cccccccc-0000-4000-8000-000000000002'
const owner: Actor = { userId: OWNER, source: 'web' }
const editor: Actor = { userId: EDITOR, source: 'web' }
const reader: Actor = { userId: READER, source: 'web' }

let pg: PGlite
let Content: typeof import('@/lib/core/page-content')

/** BlockNote 가 만드는 모양 그대로: blockGroup > blockContainer > paragraph > 글자 */
function addParagraph(doc: Y.Doc, text: string, href?: string) {
  const frag = doc.getXmlFragment(FRAGMENT)
  let group = frag.get(0) as Y.XmlElement | undefined
  if (!group) {
    group = new Y.XmlElement('blockGroup')
    frag.insert(0, [group])
  }
  const container = new Y.XmlElement('blockContainer')
  group.insert(group.length, [container])
  const paragraph = new Y.XmlElement('paragraph')
  container.insert(0, [paragraph])
  const t = new Y.XmlText()
  paragraph.insert(0, [t])
  t.insert(0, text, href ? { link: { href } } : undefined)
}

const row = async () =>
  (await pg.query<{ plain_text: string; updated_at: Date; last_edited_by: string | null }>(
    'SELECT plain_text, updated_at, last_edited_by FROM pages WHERE id = $1', [DOC],
  )).rows[0]
const links = async () =>
  (await pg.query<{ to_page_id: string; ctid: string }>(
    'SELECT to_page_id, ctid::text FROM page_links WHERE from_page_id = $1', [DOC],
  )).rows

/** 지금 서버 상태로 문서를 만든다 — 브라우저 탭이 문서를 연 것과 같다 */
async function openTab(actor: Actor) {
  const doc = new Y.Doc()
  const { update } = await Content.loadYdocState(actor, DOC)
  if (update) Y.applyUpdate(doc, update)
  return doc
}

/** 탭이 서버에 없는 부분만 보낸다 (프로바이더와 같은 방식) */
async function save(actor: Actor, doc: Y.Doc) {
  const { stateVector } = await Content.loadYdocState(actor, DOC)
  return Content.applyYdocUpdate(actor, DOC, Y.encodeStateAsUpdate(doc, stateVector))
}

beforeAll(async () => {
  pg = await createTestDb()
  holder.db = withRowArrays(drizzle(pg, { schema }))
  await pg.exec(`
    INSERT INTO auth.users VALUES ('${OWNER}'), ('${EDITOR}'), ('${READER}');
    INSERT INTO profiles (id, email, display_name) VALUES
      ('${OWNER}', 'o@x', 'o'), ('${EDITOR}', 'e@x', 'e'), ('${READER}', 'r@x', 'r');
    INSERT INTO workspaces (id, name, owner_id) VALUES ('${WS}', 'w', '${OWNER}');
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ('${WS}', '${OWNER}', 'owner'), ('${WS}', '${EDITOR}', 'member'), ('${WS}', '${READER}', 'member');
    INSERT INTO pages (id, workspace_id, parent_id, path, sort_key, title) VALUES
      ('${DOC}', '${WS}', NULL, '/', 'a0', '회의록'),
      ('${TARGET}', '${WS}', NULL, '/', 'a1', '결정 사항');
    INSERT INTO page_permissions (page_id, user_id, level) VALUES ('${DOC}', '${READER}', 'read');
  `)
  Content = await import('@/lib/core/page-content')
}, 60_000)

afterAll(async () => {
  await pg?.close()
})

function removeParagraph(doc: Y.Doc, text: string) {
  const group = doc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement
  group.delete(group.toArray().findIndex((c) => c.toString().includes(text)), 1)
}

describe('applyYdocUpdate · loadYdocState', () => {
  it('빈 문서의 첫 저장 — 평문·링크는 서버가 ydoc 에서 뽑는다. 되돌릴 "직전" 이 없어 버전 때가 아니다', async () => {
    const tab = await openTab(owner)
    addParagraph(tab, '첫 문단')
    addParagraph(tab, '결정 사항', `/p/${TARGET}`)
    const saved = await save(owner, tab)

    expect(saved).toMatchObject({ changed: true, snapshotDue: null })
    expect((await row()).plain_text).toBe('첫 문단\n결정 사항')
    expect((await links()).map((l) => l.to_page_id)).toEqual([TARGET])
  })

  it('회귀: 열기만 한 탭의 저장은 DB 를 건드리지 않는다 (수정자·수정 시각이 열람자로 바뀌지 않는다)', async () => {
    const before = await row()
    const tab = await openTab(editor)
    // 가진 걸 전부 다시 보내도 새로 더한 게 없다
    const saved = await Content.applyYdocUpdate(editor, DOC, Y.encodeStateAsUpdate(tab))
    expect(saved.changed).toBe(false)
    expect(await row()).toEqual(before)
  })

  it('회귀: 옛 상태의 탭이 저장해도 그 사이 들어온 내용(MCP 등)을 지우지 않는다 — 병합', async () => {
    const stale = await openTab(editor) // 이 탭은 여기서 멈춰 있다
    const mcp = await openTab(owner)
    addParagraph(mcp, 'MCP 가 붙인 문단')
    await save(owner, mcp)

    addParagraph(stale, '탭에서 친 문단')
    expect((await save(editor, stale)).changed).toBe(true)
    const after = await row()
    expect(after.plain_text).toContain('MCP 가 붙인 문단')
    expect(after.plain_text).toContain('탭에서 친 문단')
    expect(after.last_edited_by).toBe(EDITOR)
  })

  it('링크 표는 링크가 바뀔 때만 다시 쓴다', async () => {
    const before = (await links()).map((l) => l.ctid)
    const tab = await openTab(owner)
    addParagraph(tab, '링크 없는 문단')
    await save(owner, tab)
    expect((await links()).map((l) => l.ctid)).toEqual(before) // 지웠다 다시 넣지 않았다

    removeParagraph(tab, '결정 사항')
    await save(owner, tab)
    expect(await links()).toEqual([])
  })

  it('버전 때 — 마지막 버전이 10분보다 오래됐으면 저장 **직전** 상태를 알리고, 방금 남겼으면 알리지 않는다', async () => {
    const [{ ydoc: serverBefore }] = (await pg.query<{ ydoc: Uint8Array }>(
      'SELECT ydoc FROM pages WHERE id = $1', [DOC],
    )).rows
    const tab = await openTab(owner)
    addParagraph(tab, '버전 전에 친 문단')
    const saved = await save(owner, tab)
    expect(saved.snapshotDue?.title).toBe('회의록')
    expect(Buffer.from(saved.snapshotDue!.ydoc).equals(Buffer.from(serverBefore))).toBe(true)

    await pg.query(
      `INSERT INTO page_versions (page_id, title, content_json, author_id) VALUES ($1, '회의록', '[]', $2)`,
      [DOC, OWNER],
    )
    addParagraph(tab, '바로 뒤 문단')
    expect((await save(owner, tab)).snapshotDue).toBeNull()
  })

  it('형식이 틀린 바이트는 invalid_input — 500 으로 새지 않는다', async () => {
    await expect(Content.applyYdocUpdate(owner, DOC, new Uint8Array([1, 2, 3, 250])))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(Content.loadYdocState(owner, DOC, new Uint8Array([255, 255, 255])))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('읽기 권한만 있으면 읽을 수는 있어도 저장은 못 한다', async () => {
    const tab = await openTab(reader)
    addParagraph(tab, '몰래')
    await expect(save(reader, tab)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('상태벡터를 주면 빠진 조각만 준다 — 탭에 돌아왔을 때 전체를 다시 받지 않는다', async () => {
    const tab = await openTab(owner)
    const full = (await Content.loadYdocState(owner, DOC)).update!
    const other = await openTab(editor)
    addParagraph(other, '떠나 있던 사이의 문단')
    await save(editor, other)

    const { update } = await Content.loadYdocState(owner, DOC, Y.encodeStateVector(tab))
    expect(update!.byteLength).toBeLessThan(full.byteLength / 2)
    Y.applyUpdate(tab, update!)
    expect(tab.getXmlFragment(FRAGMENT).toString()).toContain('떠나 있던 사이의 문단')
  })
})
