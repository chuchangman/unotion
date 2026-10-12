/**
 * 페이지 이동(movePage) — 사이드바의 "옮기기" 가 부르는 경로를 실제 Postgres(PGlite) 위에서 확인한다.
 *
 * 특히 예전에 막지 않던 두 가지: 다른 룸의 부모 밑으로 옮기기(workspace_id 와 path 가 서로 다른 룸을
 * 가리키게 된다), 엉뚱한 기준 형제(정렬 키가 뒤죽박죽이 되거나 generateKeyBetween 이 예외를 던진다).
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
/** P1 을 편집 권한으로 공유받은 게스트 */
const GUEST = '22222222-2222-4222-8222-222222222222'
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WS2 = 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb'
// WS:  P1 ─ P2 ─ P4,  P3        WS2:  Q
const P1 = 'bbbbbbbb-0000-4000-8000-000000000001'
const P2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const P3 = 'bbbbbbbb-0000-4000-8000-000000000003'
const P4 = 'bbbbbbbb-0000-4000-8000-000000000004'
const Q = 'bbbbbbbb-0000-4000-8000-00000000000a'
const owner: Actor = { userId: OWNER, source: 'web' }
const guest: Actor = { userId: GUEST, source: 'web' }

let pg: PGlite
let Pages: typeof import('@/lib/core/pages')

const row = async (id: string) =>
  (await pg.query<{ path: string; parent_id: string | null; sort_key: string }>(
    'SELECT path, parent_id, sort_key FROM pages WHERE id = $1', [id],
  )).rows[0]

beforeAll(async () => {
  pg = await createTestDb()
  holder.db = withRowArrays(drizzle(pg, { schema }))
  await pg.exec(`
    INSERT INTO auth.users VALUES ('${OWNER}'), ('${GUEST}');
    INSERT INTO profiles (id, email, display_name) VALUES ('${OWNER}', 'o@x', 'o'), ('${GUEST}', 'g@x', 'g');
    INSERT INTO workspaces (id, name, owner_id) VALUES ('${WS}', 'w', '${OWNER}'), ('${WS2}', 'w2', '${OWNER}');
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ('${WS}', '${OWNER}', 'owner'), ('${WS2}', '${OWNER}', 'owner'), ('${WS}', '${GUEST}', 'guest');
    INSERT INTO pages (id, workspace_id, parent_id, path, sort_key, title) VALUES
      ('${P1}', '${WS}',  NULL,    '/',             'a0', '하나'),
      ('${P2}', '${WS}',  '${P1}', '/${P1}/',       'a0', '둘'),
      ('${P4}', '${WS}',  '${P2}', '/${P1}/${P2}/', 'a0', '넷'),
      ('${P3}', '${WS}',  NULL,    '/',             'a1', '셋'),
      ('${Q}',  '${WS2}', NULL,    '/',             'a0', '다른 룸');
    INSERT INTO page_permissions (page_id, user_id, level) VALUES ('${P1}', '${GUEST}', 'edit');
  `)
  Pages = await import('@/lib/core/pages')
}, 60_000)

afterAll(async () => {
  await pg?.close()
})

describe('movePage', () => {
  it('게스트는 공유받은 문서 밖(최상위)으로는 못 옮기고, 안에서는 옮길 수 있다', async () => {
    // 최상위로 가면 게스트 본인도 못 여는 문서가 된다 (createPage 와 같은 규칙)
    await expect(Pages.movePage(guest, P2, { parentId: null })).rejects.toThrow(/게스트/)
    expect(await row(P2)).toMatchObject({ parent_id: P1 })

    await Pages.movePage(guest, P4, { parentId: P1 })
    expect(await row(P4)).toMatchObject({ parent_id: P1, path: `/${P1}/` })
    // 되돌려 둔다 — 아래 테스트는 처음 트리를 가정한다
    await Pages.movePage(owner, P4, { parentId: P2 })
    expect((await row(P4)).path).toBe(`/${P1}/${P2}/`)
  })

  it('다른 프로젝트 룸의 페이지 밑으로는 못 옮긴다 (두 룸 다 편집 권한이 있어도)', async () => {
    await expect(Pages.movePage(owner, P3, { parentId: Q })).rejects.toThrow(/다른 프로젝트 룸/)
    expect(await row(P3)).toMatchObject({ parent_id: null, path: '/' })
  })

  it('자기 하위로는 못 옮긴다', async () => {
    await expect(Pages.movePage(owner, P1, { parentId: P4 })).rejects.toThrow(/하위/)
  })

  it('기준 형제가 옮겨 갈 부모의 자식이 아니면 거부한다', async () => {
    // P2 는 최상위가 아니다
    await expect(Pages.movePage(owner, P3, { parentId: null, afterId: P2 })).rejects.toThrow(/위치/)
    // 순서가 뒤집혀 온 경우
    await expect(Pages.movePage(owner, P4, { parentId: null, afterId: P3, beforeId: P1 })).rejects.toThrow(/위치/)
  })

  it('옮기면 하위 트리의 path 가 함께 바뀐다', async () => {
    await Pages.movePage(owner, P2, { parentId: P3 })
    expect(await row(P2)).toMatchObject({ parent_id: P3, path: `/${P3}/` })
    expect((await row(P4)).path).toBe(`/${P3}/${P2}/`)
  })

  it('두 형제 사이로 옮기면 정렬 키가 그 사이에 온다', async () => {
    // 최상위: P1(a0) · P3(a1). P4 를 그 사이로
    await Pages.movePage(owner, P4, { parentId: null, afterId: P1, beforeId: P3 })
    const key = (await row(P4)).sort_key
    expect(key > (await row(P1)).sort_key && key < (await row(P3)).sort_key).toBe(true)
    expect((await row(P4)).path).toBe('/')
  })
})
