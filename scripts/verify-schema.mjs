/** 마이그레이션이 의도대로 적용됐는지 실제 DB 에서 확인한다. */
import postgres from 'postgres'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

const url = new URL(process.env.DATABASE_URL)
if (url.port === '6543') url.port = '5432'
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} })

const check = (label, ok, extra = '') =>
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`)

try {
  console.log('\n[1] 테이블')
  const tables = await sql`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  check(`public 테이블 ${tables.length}개`, tables.length >= 17)
  console.log('      ' + tables.map((t) => t.tablename).join(', '))

  console.log('\n[2] drizzle 이 못 만든 FK')
  const fks = await sql`
    SELECT conname FROM pg_constraint
     WHERE conname IN ('pages_parent_id_fk','pages_collection_id_fk',
                       'collections_page_id_fk','profiles_id_auth_users_fk')`
  const names = fks.map((f) => f.conname)
  for (const n of ['pages_parent_id_fk', 'pages_collection_id_fk',
                   'collections_page_id_fk', 'profiles_id_auth_users_fk']) {
    check(n, names.includes(n))
  }

  console.log('\n[3] 한글 검색')
  const [{ ok: trgm }] = await sql`
    SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS ok`
  check('pg_trgm 확장', trgm)
  const idx = await sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename='pages' AND indexname LIKE '%trgm%' OR indexname='pages_search_vector_idx'`
  check(`검색 인덱스 ${idx.length}개`, idx.length >= 3,
    idx.map((i) => i.indexname).join(', '))
  const [{ cnt: trg }] = await sql`
    SELECT count(*)::int AS cnt FROM pg_trigger WHERE tgname='pages_search_vector_trg'`
  check('search_vector 트리거', trg === 1)

  console.log('\n[4] RLS')
  const rls = await sql`
    SELECT relname, relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND relname <> '_migrations'
     ORDER BY relname`
  const off = rls.filter((r) => !r.relrowsecurity).map((r) => r.relname)
  check(`RLS 활성 ${rls.filter((r) => r.relrowsecurity).length}/${rls.length}`,
    off.length === 0, off.length ? '누락: ' + off.join(', ') : '')

  const [{ cnt: pol }] = await sql`
    SELECT count(*)::int AS cnt FROM pg_policies WHERE schemaname='public'`
  check(`public 정책 ${pol}개`, pol >= 14)

  console.log('\n[5] Realtime 채널 인가 (가장 불확실했던 부분)')
  const rt = await sql`
    SELECT policyname, cmd FROM pg_policies
     WHERE schemaname='realtime' AND tablename='messages' ORDER BY policyname`
  check(`realtime.messages 정책 ${rt.length}개`, rt.length >= 2,
    rt.map((r) => `${r.policyname}(${r.cmd})`).join(', '))

  console.log('\n[6] 보안 모델 전제 검증')
  const [{ rolname, rolbypassrls, rolsuper }] = await sql`
    SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`
  check(`현재 역할 '${rolname}' 이 RLS 를 우회함`, rolbypassrls || rolsuper,
    `bypassrls=${rolbypassrls} super=${rolsuper}`)
  console.log('      → 사실이면 실제 권한 강제는 lib/core/permissions.ts 다 (설계대로)')

  const [{ ok: fnOk }] = await sql`
    SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='public' AND p.proname='can_read_page') AS ok`
  check('can_read_page() 헬퍼 함수', fnOk)

  console.log()
} finally {
  await sql.end({ timeout: 5 })
}
