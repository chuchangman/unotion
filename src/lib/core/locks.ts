/**
 * 트랜잭션 advisory lock. 트랜잭션이 끝나면 저절로 풀린다 (트랜잭션 풀러 6543 에서도 안전하다).
 *
 * 첫 번째 키로 기능을 나눈다 — 두 번째 키(hashtext)는 32비트라 서로 다른 기능의 키가
 * 우연히 같을 수 있는데, 그래도 기능이 다르면 서로 기다리지 않게 하려는 것이다.
 */
import { sql, type SQL } from 'drizzle-orm'

const SCOPE = {
  /** 같은 룸의 페이지 이동을 한 줄로 (pages.ts 의 movePage) */
  pageMove: 1,
  /** 같은 페이지의 버전 스냅샷을 한 줄로 (page-content.ts 의 recordVersionSnapshot) */
  pageVersion: 2,
} as const

export function xactLock(scope: keyof typeof SCOPE, key: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(${SCOPE[scope]}::int, hashtext(${key}))`
}
