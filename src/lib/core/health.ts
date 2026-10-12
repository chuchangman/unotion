/**
 * 배포 확인용 DB 핑. 인증 없이 불리지만 데이터에 닿지 않는다(select 1).
 *
 * 권한 검사가 없는 유일한 core 함수다 — 사용자 데이터를 읽지 않기 때문이다.
 * 라우트(app/api/health)가 db 를 직접 import 하지 않게 여기 둔다 (README 아키텍처 불변식).
 */
import { sql } from 'drizzle-orm'
import { db } from './db'

export async function pingDatabase(): Promise<void> {
  await db.execute(sql`select 1`)
}
