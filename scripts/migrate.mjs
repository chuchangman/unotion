/**
 * SQL 마이그레이션 러너.
 *
 *   node scripts/migrate.mjs          적용
 *   node scripts/migrate.mjs --status 적용 현황만 확인
 *
 * 왜 drizzle-kit push 를 안 쓰나:
 *   0001/0002 는 drizzle 이 만들지 못하는 것들(순환 FK, 트리거, RLS,
 *   realtime.messages 정책)이라 손으로 쓴 SQL 이다. push 는 이걸 모른다.
 *
 * 왜 세션 풀러(5432)인가:
 *   앱은 트랜잭션 풀러(6543)를 쓰지만 DDL 은 세션 상태가 필요하다.
 *   DATABASE_URL 의 포트만 5432 로 바꿔 같은 풀러 호스트에 붙는다 (IPv4 호환).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { config as loadEnv } from 'dotenv'

// Next.js 는 .env.local 을 자동으로 읽지만 plain node 는 안 읽는다.
loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })   // 폴백 (기존 값은 덮어쓰지 않는다)

const MIGRATIONS_DIR = 'drizzle'

function sessionPoolerUrl(raw) {
  if (!raw) throw new Error('DATABASE_URL 이 없습니다 (.env.local 확인)')
  const url = new URL(raw)
  if (url.port === '6543') url.port = '5432'
  return url.toString()
}

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }))
}

const statusOnly = process.argv.includes('--status')

const sql = postgres(sessionPoolerUrl(process.env.DATABASE_URL), {
  max: 1,
  idle_timeout: 10,
  connect_timeout: 30,
  onnotice: () => {},
})

try {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `).simple()

  const applied = new Set(
    (await sql`SELECT name FROM _migrations`).map((r) => r.name),
  )
  const all = loadMigrations()

  if (statusOnly) {
    console.log('\n적용 현황:')
    for (const m of all) {
      console.log(`  ${applied.has(m.name) ? '[적용됨]' : '[대기  ]'} ${m.name}`)
    }
    console.log()
    process.exit(0)
  }

  const pending = all.filter((m) => !applied.has(m.name))
  if (pending.length === 0) {
    console.log('적용할 마이그레이션이 없습니다. 모두 최신입니다.')
    process.exit(0)
  }

  for (const m of pending) {
    process.stdout.write(`\n▶ ${m.name} ... `)
    try {
      // 파일 단위 원자성: 하나라도 실패하면 전체 롤백
      await sql.unsafe(
        `BEGIN;\n${m.sql}\n;\nINSERT INTO _migrations(name) VALUES ('${m.name}');\nCOMMIT;`,
      ).simple()
      console.log('완료')
    } catch (err) {
      console.log('실패')
      console.error(`\n  ${err.message}`)
      if (err.position) console.error(`  위치: ${err.position}`)
      if (err.detail) console.error(`  상세: ${err.detail}`)
      if (err.hint) console.error(`  힌트: ${err.hint}`)
      console.error('\n  이 파일은 롤백됐습니다. 원인을 고치고 다시 실행하세요.\n')
      process.exit(1)
    }
  }

  console.log('\n전부 적용됐습니다.\n')
} finally {
  await sql.end({ timeout: 5 })
}
