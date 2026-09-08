/**
 * Postgres 연결 (Supabase).
 *
 * ⚠️ 보안 모델 — 이 프로젝트에서 가장 중요한 불변식이다.
 *
 * 이 연결은 RLS를 우회한다. 따라서 **모든** 데이터 접근은 lib/core/* 의 함수를
 * 통해야 하고, 그 함수들은 예외 없이 첫 인자로 Actor 를 받아
 * permissions.ts 의 assert* 를 먼저 호출한다.
 *
 * 웹 UI / REST API / MCP 서버가 모두 같은 게이트를 지난다.
 * lib/core 밖에서 db 를 직접 import 하면 그 게이트가 뚫린다 — 하지 마라.
 * (RLS 정책은 브라우저 anon 키 접근과 Realtime 에 대한 2차 방어선이다.)
 *
 * 연결은 지연 생성한다: 빌드 타임에 DATABASE_URL 없이도 모듈 임포트가 성공해야 한다.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

type DrizzleDb = PostgresJsDatabase<typeof schema>

let instance: DrizzleDb | null = null

function init(): DrizzleDb {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL 이 없습니다. Supabase 대시보드 > Project Settings > Database > ' +
      'Connection string > Transaction pooler (포트 6543) 값을 .env.local 에 넣으세요.',
    )
  }

  // ── 포트 규칙 (환경마다 다르다)
  //   프로덕션(Vercel) : 6543 트랜잭션 풀러 — 서버리스에서 연결 고갈을 막는다
  //   로컬 개발        : 5432 세션 풀러   — 일부 사내/캠퍼스망이 6543 아웃바운드를 막는다
  // prepare:false 는 6543 에서 필수이고 5432 에서도 무해하므로 양쪽 다 켜 둔다.
  const client = postgres(connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    // 기본값은 재시도하며 20초 넘게 매달린다. 막힌 포트를 빨리 드러내려면 짧게 잡는다.
    connect_timeout: 10,
  })

  return drizzle(client, { schema })
}

/** 첫 접근 시 연결을 만든다 (빌드 타임 임포트 안전) */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    instance ??= init()
    return Reflect.get(instance, prop, receiver)
  },
})

export { schema }
export type Db = DrizzleDb
