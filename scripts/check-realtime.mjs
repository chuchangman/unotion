/**
 * 실시간 동시 편집 점검.
 *
 *   npm run check:realtime
 *
 * 임시 테스트 계정을 만들어 **실제 사용자 JWT** 로 private 채널에 붙고,
 * 두 클라이언트 사이 broadcast 왕복이 되는지 확인한 뒤 계정을 되돌린다.
 *
 * 왜 필요한가: private 채널은 setAuth() 로 소켓에 JWT 를 실어야 한다.
 * 빠뜨리면 realtime.messages RLS 안에서 auth.uid() 가 비어 구독이 통째로 거부되는데,
 * 화면에는 "오프라인" 배지만 떠서 원인을 알 수 없다. 이 스크립트가 그걸 가른다.
 */
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!URL || !KEY || !process.env.DATABASE_URL) {
  console.error('\n.env.local 에 SUPABASE URL / ANON_KEY / DATABASE_URL 이 필요합니다.\n')
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} })

const stamp = Date.now()
const email = `rt-test-${stamp}@example.com`
const password = `Test-${stamp}-Aa!`
let userId = null

async function cleanup() {
  if (!userId) return
  await sql`DELETE FROM workspace_members WHERE user_id = ${userId}`
  await sql`DELETE FROM profiles WHERE id = ${userId}`
  await sql`DELETE FROM auth.users WHERE id = ${userId}`
  console.log('  테스트 계정 되돌림')
}

try {
  console.log(`\n임시 계정: ${email}`)
  const boot = createClient(URL, KEY)

  const { data: su, error: suErr } = await boot.auth.signUp({ email, password })
  if (suErr) throw new Error(`signUp: ${suErr.message}`)
  userId = su.user?.id ?? null
  if (!su.session) {
    // 이메일 확인이 켜져 있으면 세션이 안 나온다 — 테스트 계정만 직접 확인 처리
    await sql`UPDATE auth.users SET email_confirmed_at = now() WHERE email = ${email}`
  }

  const { data: si, error: siErr } = await boot.auth.signInWithPassword({ email, password })
  if (siErr) throw new Error(`signIn: ${siErr.message}`)
  userId = si.user.id

  const [ws] = await sql`SELECT id, name FROM workspaces ORDER BY created_at LIMIT 1`
  const [pg] = await sql`SELECT id, title FROM pages WHERE workspace_id = ${ws.id} AND NOT is_trashed LIMIT 1`
  if (!pg) throw new Error('테스트할 페이지가 없습니다')

  await sql`INSERT INTO profiles (id, email, display_name)
            VALUES (${userId}, ${email}, 'RT 점검') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO workspace_members (workspace_id, user_id, role)
            VALUES (${ws.id}, ${userId}, 'member') ON CONFLICT DO NOTHING`
  console.log(`  "${ws.name}" 멤버로 참여 · 대상 페이지 "${pg.title}"`)

  const session = {
    access_token: si.session.access_token,
    refresh_token: si.session.refresh_token,
  }

  /** 앱의 프로바이더와 같은 순서로 붙는다 */
  async function join(label, withAuth) {
    const c = createClient(URL, KEY)
    await c.auth.setSession(session)
    if (withAuth) await c.realtime.setAuth()
    const ch = c.channel(pg.id, { config: { broadcast: { self: false }, private: true } })
    const inbox = []
    ch.on('broadcast', { event: 'y-update' }, ({ payload }) => inbox.push(payload))
    const status = await new Promise((res) => {
      ch.subscribe((st, e) => {
        if (st === 'SUBSCRIBED') res('OK')
        else if (st !== 'JOINING') res(`${st}${e ? ': ' + (e.message ?? e) : ''}`)
      })
      setTimeout(() => res('TIMEOUT'), 12000)
    })
    console.log(`  ${label}: ${status === 'OK' ? 'OK' : 'FAIL  ' + status}`)
    return { client: c, ch, inbox, status }
  }

  console.log('\n[대조군] setAuth 없이 (예전 동작):')
  const bad = await join('구독', false)
  await bad.client.removeChannel(bad.ch)

  console.log('\n[현재] setAuth 적용:')
  const A = await join('A 구독', true)

  let roundtrip = 'SKIP'
  if (A.status === 'OK') {
    const B = await join('B 구독', true)
    if (B.status === 'OK') {
      await B.ch.send({ type: 'broadcast', event: 'y-update', payload: { update: 'SYNC_PROBE' } })
      await new Promise((r) => setTimeout(r, 3000))
      roundtrip = A.inbox.some((p) => p.update === 'SYNC_PROBE') ? 'OK' : 'FAIL'
      console.log(`  B -> A 전파: ${roundtrip === 'OK' ? 'OK' : 'FAIL'}`)
    }
    await B.client.removeChannel(B.ch)
  }
  await A.client.removeChannel(A.ch)

  const verdict = A.status === 'OK' && roundtrip === 'OK'
  console.log(`\n=== 실시간 동시 편집: ${verdict ? '동작함' : '동작 안 함'} ===`)
  if (!verdict) process.exitCode = 1
} catch (err) {
  console.error('\n오류:', err.message)
  process.exitCode = 1
} finally {
  await cleanup()
  await sql.end({ timeout: 3 }).catch(() => {})
  console.log()
  process.exit(process.exitCode ?? 0)
}
