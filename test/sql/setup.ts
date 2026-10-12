/**
 * SQL 테스트 공용 준비: PGlite(메모리 속 Postgres)에 **실제 마이그레이션 파일**을 그대로 적용한다.
 *
 * Supabase 가 제공하는 것(auth.uid(), realtime.topic(), realtime.messages)만 최소한으로 흉내 낸다.
 * 0003/0004(스토리지 버킷)는 storage 스키마가 필요하고 여기서 확인할 게 없어 뺀다.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

const MIGRATIONS = [
  '0000_init.sql',
  '0001_constraints_and_search.sql',
  '0002_rls.sql',
  '0005_realtime_policies.sql',
]

/** Supabase 가 깔아 주는 것들의 최소 대역 */
const SUPABASE_STUBS = `
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE anon NOLOGIN;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  CREATE SCHEMA realtime;
  CREATE TABLE realtime.messages (
    id bigserial PRIMARY KEY,
    topic text NOT NULL,
    extension text NOT NULL DEFAULT 'broadcast',
    event text,
    payload jsonb
  );
  CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('realtime.topic', true), '')
  $$;
  ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

  GRANT USAGE ON SCHEMA auth, realtime, public TO authenticated;
  GRANT SELECT, INSERT ON realtime.messages TO authenticated;
  GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO authenticated;
`

/**
 * lib/core 는 db.execute 결과를 행 배열로 쓴다(postgres-js). PGlite 드라이버는 { rows } 를
 * 돌려주므로 배열로 맞춘다 — 트랜잭션 안의 tx 도 같이.
 */
export function withRowArrays<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop)
      if (prop === 'execute') {
        return async (query: unknown) =>
          (await (value as (q: unknown) => Promise<{ rows: unknown[] }>).call(t, query)).rows
      }
      if (prop === 'transaction') {
        return (fn: (tx: object) => Promise<unknown>) =>
          (value as (f: (tx: object) => Promise<unknown>) => Promise<unknown>)
            .call(t, (tx: object) => fn(withRowArrays(tx)))
      }
      return typeof value === 'function' ? value.bind(t) : value
    },
  })
}

export async function createTestDb(): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { pg_trgm } })
  await db.exec(SUPABASE_STUBS)
  for (const file of MIGRATIONS) {
    await db.exec(readFileSync(join(process.cwd(), 'drizzle', file), 'utf8'))
  }
  return db
}
