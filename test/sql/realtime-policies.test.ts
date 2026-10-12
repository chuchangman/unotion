/**
 * Realtime 채널 권한 (drizzle/0005_realtime_policies.sql) 을 진짜 Postgres 위에서 확인한다.
 *
 * PGlite(메모리 속 Postgres)에 실제 마이그레이션 파일을 그대로 적용하고, Supabase 가
 * 제공하는 것(auth.uid(), realtime.topic(), realtime.messages)만 최소한으로 흉내 낸다.
 * RLS 는 슈퍼유저에게 안 걸리므로 정책 검사는 authenticated 역할로 바꿔서 한다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDb } from './setup'

// 사람
const OWNER = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
const READER = '33333333-3333-4333-8333-333333333333' // 멤버인데 P2 에만 read 가 걸렸다
const STRANGER = '44444444-4444-4444-8444-444444444444' // 다른 워크스페이스 사람
// 워크스페이스와 페이지:  P1 ─ P2 ─ P4,  P3
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const P1 = 'bbbbbbbb-0000-4000-8000-000000000001'
const P2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const P3 = 'bbbbbbbb-0000-4000-8000-000000000003'
const P4 = 'bbbbbbbb-0000-4000-8000-000000000004'

let db: PGlite

beforeAll(async () => {
  db = await createTestDb()

  await db.exec(`
    INSERT INTO auth.users VALUES ('${OWNER}'), ('${GUEST}'), ('${READER}'), ('${STRANGER}');
    INSERT INTO profiles (id, email, display_name) VALUES
      ('${OWNER}', 'o@x', 'o'), ('${GUEST}', 'g@x', 'g'),
      ('${READER}', 'r@x', 'r'), ('${STRANGER}', 's@x', 's');
    INSERT INTO workspaces (id, name, owner_id) VALUES ('${WS}', 'w', '${OWNER}');
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ('${WS}', '${OWNER}', 'owner'), ('${WS}', '${GUEST}', 'guest'), ('${WS}', '${READER}', 'member');
    INSERT INTO pages (id, workspace_id, parent_id, path, sort_key, title) VALUES
      ('${P1}', '${WS}', NULL,     '/',              'a0', '루트'),
      ('${P2}', '${WS}', '${P1}', '/${P1}/',         'a0', '하위'),
      ('${P3}', '${WS}', NULL,     '/',              'a1', '다른 루트'),
      ('${P4}', '${WS}', '${P2}', '/${P1}/${P2}/',   'a0', '손자');
    INSERT INTO page_permissions (page_id, user_id, level) VALUES
      ('${P1}', '${GUEST}', 'read'),
      ('${P3}', '${GUEST}', 'edit'),
      ('${P2}', '${READER}', 'read');
  `)
}, 60_000)

afterAll(async () => {
  await db?.close()
})

async function as<T>(userId: string, topic: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId])
  await db.query(`SELECT set_config('realtime.topic', $1, false)`, [topic ?? ''])
  return fn()
}

async function canEdit(userId: string, pageId: string | null): Promise<boolean> {
  return as(userId, null, async () => {
    const { rows } = await db.query<{ ok: boolean }>(`SELECT public.can_edit_page($1::uuid) AS ok`, [pageId])
    return rows[0].ok
  })
}

/** authenticated 역할로 그 토픽에 보낼 수 있는지 (RLS INSERT 정책) */
async function canSend(userId: string, topic: string): Promise<boolean> {
  return as(userId, topic, async () => {
    await db.exec('SET ROLE authenticated')
    try {
      await db.query(`INSERT INTO realtime.messages (topic, event) VALUES ($1, 'y-update')`, [topic])
      return true
    } catch (err) {
      if (/row-level security/i.test(String((err as Error).message))) return false
      throw err
    } finally {
      await db.exec('RESET ROLE')
    }
  })
}

/** authenticated 역할로 그 토픽의 메시지를 받을 수 있는지 (RLS SELECT 정책) */
async function canReceive(userId: string, topic: string): Promise<boolean> {
  await db.query(`INSERT INTO realtime.messages (topic, event) VALUES ($1, 'probe')`, [topic])
  return as(userId, topic, async () => {
    await db.exec('SET ROLE authenticated')
    try {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM realtime.messages WHERE topic = $1`, [topic],
      )
      return rows[0].n > 0
    } finally {
      await db.exec('RESET ROLE')
    }
  })
}

describe('can_edit_page — permissions.ts 의 resolvePageAccess 와 같은 규칙', () => {
  it('역할 기본값: owner/member 는 편집, 다른 워크스페이스 사람은 못 한다', async () => {
    expect(await canEdit(OWNER, P4)).toBe(true)
    expect(await canEdit(READER, P1)).toBe(true)
    expect(await canEdit(STRANGER, P1)).toBe(false)
  })

  it('가장 가까운 명시 권한이 이긴다 — 멤버라도 read 가 걸린 곳과 그 아래는 읽기 전용', async () => {
    expect(await canEdit(READER, P2)).toBe(false)
    expect(await canEdit(READER, P4)).toBe(false) // P2 에서 물려받는다
  })

  it('게스트는 edit 로 공유받은 곳만 편집한다', async () => {
    expect(await canEdit(GUEST, P1)).toBe(false) // read 공유
    expect(await canEdit(GUEST, P4)).toBe(false) // P1 의 read 를 물려받는다
    expect(await canEdit(GUEST, P3)).toBe(true)
  })

  it('없는 페이지나 NULL 은 거부', async () => {
    expect(await canEdit(OWNER, null)).toBe(false)
    expect(await canEdit(OWNER, 'cccccccc-0000-4000-8000-000000000000')).toBe(false)
  })
})

describe('realtime.messages 정책', () => {
  it('회귀: 읽기 권한만 있으면 페이지 채널에 보낼 수 없다 (예전엔 보낼 수 있었다)', async () => {
    expect(await canSend(READER, P2)).toBe(false)
    expect(await canSend(GUEST, P4)).toBe(false)
  })

  it('편집 권한이 있으면 보낼 수 있다', async () => {
    expect(await canSend(OWNER, P2)).toBe(true)
    expect(await canSend(READER, P3)).toBe(true)
    expect(await canSend(GUEST, P3)).toBe(true)
  })

  it('읽기 권한이 있으면 받을 수는 있다', async () => {
    expect(await canReceive(READER, P2)).toBe(true)
    expect(await canReceive(GUEST, P4)).toBe(true)
    expect(await canReceive(STRANGER, P1)).toBe(false)
  })

  it('워크스페이스 신호 채널(ws:<id>)은 게스트를 뺀 멤버만', async () => {
    const topic = `ws:${WS}`
    expect(await canSend(OWNER, topic)).toBe(true)
    expect(await canSend(READER, topic)).toBe(true)
    expect(await canSend(GUEST, topic)).toBe(false)
    expect(await canSend(STRANGER, topic)).toBe(false)
    expect(await canReceive(GUEST, topic)).toBe(false)
    expect(await canReceive(OWNER, topic)).toBe(true)
  })

  it('uuid 가 아닌 토픽은 오류 없이 거부한다 (예전 정책은 캐스팅에서 터졌다)', async () => {
    expect(await canSend(OWNER, 'not-a-page')).toBe(false)
    expect(await canSend(OWNER, 'ws:not-a-workspace')).toBe(false)
  })
})
