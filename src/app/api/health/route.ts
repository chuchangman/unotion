import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/core/db'

export const dynamic = 'force-dynamic'

/**
 * 배포 확인용. 인증 없이 접근 가능하지만 스키마나 데이터는 노출하지 않는다.
 *
 * 특히 로컬(5432)과 프로덕션(6543)이 서로 다른 풀러 포트를 쓰기 때문에,
 * "로컬에서 됐으니 배포도 되겠지" 가 성립하지 않는다. 이 엔드포인트가 그걸 가른다.
 */
export async function GET() {
  const started = Date.now()
  try {
    await db.execute(sql`select 1`)
    return NextResponse.json({
      status: 'ok',
      db: 'connected',
      latencyMs: Date.now() - started,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[health] DB 연결 실패', err)
    return NextResponse.json(
      {
        status: 'error',
        db: 'unreachable',
        latencyMs: Date.now() - started,
        // 접속 문자열은 절대 노출하지 않는다. 오류 코드만 흘린다.
        hint: /CONNECT_TIMEOUT|ETIMEDOUT/i.test(message)
          ? 'DATABASE_URL 포트를 확인하세요 (서버리스는 6543 트랜잭션 풀러)'
          : message.slice(0, 120),
      },
      { status: 503 },
    )
  }
}
