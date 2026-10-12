/**
 * 게스트 노출 회귀 테스트 — lib/core 함수를 실제 Postgres(PGlite) 위에서 부른다.
 *
 * 예전에는 트리·검색·최근 변경·백링크·휴지통이 "멤버인지" 만 봐서, 공유받은 문서만 봐야 하는
 * 게스트에게 모든 제목과 본문 발췌가 나갔다. MCP(search_pages, list_pages)도 같은 함수를 쓴다.
 *
 * lib/core/db 를 PGlite 위의 drizzle 로 바꿔 끼운다. 생 SQL(db.execute)의 결과 모양이
 * 드라이버마다 달라서(postgres-js 는 배열, PGlite 는 { rows }) 배열로 맞춰 준다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '@/lib/core/schema'
import type { Actor } from '@/lib/core/actor'
import { createTestDb, withRowArrays } from './setup'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/core/db', () => ({
  db: new Proxy({}, { get: (_t, prop) => Reflect.get(holder.db as object, prop) }),
}))

const OWNER = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
// P1 ─ P2 ─ P4,  P3,  P5(비밀)  — 게스트는 P2 를 read, P3 를 edit 로 공유받았다
const P1 = 'bbbbbbbb-0000-4000-8000-000000000001'
const P2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const P3 = 'bbbbbbbb-0000-4000-8000-000000000003'
const P4 = 'bbbbbbbb-0000-4000-8000-000000000004'
const P5 = 'bbbbbbbb-0000-4000-8000-000000000005'
const VISIBLE_TO_GUEST = [P2, P3, P4].sort()

const owner: Actor = { userId: OWNER, source: 'web' }
const guest: Actor = { userId: GUEST, source: 'web' }

let pg: PGlite
let Pages: typeof import('@/lib/core/pages')
let Content: typeof import('@/lib/core/page-content')
let Workspaces: typeof import('@/lib/core/workspaces')

beforeAll(async () => {
  pg = await createTestDb()
  holder.db = withRowArrays(drizzle(pg, { schema }))

  await pg.exec(`
    INSERT INTO auth.users VALUES ('${OWNER}'), ('${GUEST}');
    INSERT INTO profiles (id, email, display_name) VALUES ('${OWNER}', 'o@x', 'o'), ('${GUEST}', 'g@x', 'g');
    INSERT INTO workspaces (id, name, owner_id) VALUES ('${WS}', 'w', '${OWNER}');
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ('${WS}', '${OWNER}', 'owner'), ('${WS}', '${GUEST}', 'guest');
    INSERT INTO pages (id, workspace_id, parent_id, path, sort_key, title, plain_text) VALUES
      ('${P1}', '${WS}', NULL,    '/',            'a0', '팀 루트', ''),
      ('${P2}', '${WS}', '${P1}', '/${P1}/',       'a0', '공유받은 문서', ''),
      ('${P4}', '${WS}', '${P2}', '/${P1}/${P2}/', 'a0', '그 아래', ''),
      ('${P3}', '${WS}', NULL,    '/',            'a1', '같이 쓰는 문서', ''),
      ('${P5}', '${WS}', NULL,    '/',            'a2', '비밀 문서', '비밀 계획');
    INSERT INTO page_permissions (page_id, user_id, level) VALUES
      ('${P2}', '${GUEST}', 'read'), ('${P3}', '${GUEST}', 'edit');
    INSERT INTO page_links (from_page_id, to_page_id) VALUES ('${P5}', '${P3}');
  `)

  Pages = await import('@/lib/core/pages')
  Content = await import('@/lib/core/page-content')
  Workspaces = await import('@/lib/core/workspaces')
}, 60_000)

afterAll(async () => {
  await pg?.close()
})

describe('게스트에게는 공유받은 문서만 보인다', () => {
  it('사이드바 트리 — 조상을 못 보는 공유 문서는 최상위로 올린다', async () => {
    const tree = await Pages.getPageTree(guest, WS)
    expect(tree.map((n) => n.id).sort()).toEqual(VISIBLE_TO_GUEST)
    expect(tree.find((n) => n.id === P2)?.parentId).toBeNull()
    expect(tree.find((n) => n.id === P4)?.parentId).toBe(P2)

    expect(await Pages.getPageTree(owner, WS)).toHaveLength(5)
  })

  it('⌘K 검색 — 못 보는 문서의 본문 발췌가 나가지 않는다', async () => {
    expect(await Pages.searchPages(guest, WS, '비밀')).toEqual([])
    expect((await Pages.searchPages(owner, WS, '비밀')).map((h) => h.id)).toEqual([P5])
  })

  it('@링크 검색과 최근 변경(MCP 주간 보고)', async () => {
    const links = await Pages.searchPagesForLink(guest, WS, '')
    expect(links.map((p) => p.id).sort()).toEqual(VISIBLE_TO_GUEST)
    const recent = await Pages.getRecentChanges(guest, WS, new Date(0))
    expect(recent.map((r) => r.id).sort()).toEqual(VISIBLE_TO_GUEST)
  })

  it('백링크 — 못 보는 문서가 이 문서를 가리켜도 제목이 나가지 않는다', async () => {
    expect(await Content.listBacklinks(guest, P3)).toEqual([])
    expect((await Content.listBacklinks(owner, P3)).map((b) => b.id)).toEqual([P5])
  })

  it('처음 열 문서 — 게스트는 공유받은 것 중 가장 얕은 것', async () => {
    expect(await Workspaces.getFirstPageId(guest, WS)).toBe(P3)
    expect(await Workspaces.getFirstPageId(owner, WS)).toBe(P1)
  })

  it('최상위에는 못 만들고, edit 로 공유받은 곳 안에는 만든다', async () => {
    await expect(
      Pages.createPage(guest, { workspaceId: WS, parentId: null, title: '루트에' }),
    ).rejects.toThrow(/게스트/)
    const child = await Pages.createPage(guest, { workspaceId: WS, parentId: P3, title: '안에' })
    expect(child.parentId).toBe(P3)
  })

  it('휴지통 — 못 보는 문서는 목록에 없다', async () => {
    await Pages.trashPage(owner, P5)
    expect(await Pages.listTrashed(guest, WS)).toEqual([])
    expect((await Pages.listTrashed(owner, WS)).map((t) => t.id)).toEqual([P5])
  })
})
