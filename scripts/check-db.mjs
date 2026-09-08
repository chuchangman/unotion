/** 앱이 실제로 쓰는 DATABASE_URL 로 붙어보고, 막힌 포트를 빨리 드러낸다. */
import postgres from 'postgres'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

const raw = process.env.DATABASE_URL
if (!raw) { console.error('\nDATABASE_URL 이 없습니다 (.env.local)\n'); process.exit(1) }
const u = new URL(raw)
console.log(`\n대상: ${u.hostname}:${u.port}`)

const sql = postgres(raw, { prepare: false, max: 1, connect_timeout: 10, onnotice: () => {} })
try {
  const t0 = Date.now()
  const [r] = await sql`select current_user, inet_server_port() as port`
  const [{ n }] = await sql`select count(*)::int as n from pages`
  console.log(`OK  (${Date.now() - t0}ms)  user=${r.current_user}  pages=${n}\n`)
} catch (e) {
  console.error(`FAIL  ${e.code ?? ''} ${e.message}`)
  if (String(e.code).includes('CONNECT_TIMEOUT') && u.port === '6543') {
    console.error(
      '\n6543(트랜잭션 풀러)이 막혀 있습니다. 일부 사내/캠퍼스망이 이 포트를 드롭합니다.' +
      '\n로컬에서는 .env.local 의 포트를 5432(세션 풀러)로 바꾸세요.' +
      '\nVercel 에는 6543 을 그대로 넣습니다 — 서버리스에는 트랜잭션 풀러가 맞습니다.\n')
  }
  process.exit(1)
} finally {
  await sql.end({ timeout: 3 }).catch(() => {})
}
