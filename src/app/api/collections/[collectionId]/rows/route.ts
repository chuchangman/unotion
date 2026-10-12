/**
 * 데이터베이스의 행을 다시 읽는다 — 다른 사람이 표를 고쳤다는 실시간 신호를 받았을 때
 * CollectionView 가 부른다 (components/live/WorkspaceLive.tsx).
 * 뷰의 필터·정렬은 클라이언트가 applyView 로 한다 (서버와 같은 규칙 파일).
 */
import * as Collections from '@/lib/core/collections'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: RouteContext<'/api/collections/[collectionId]/rows'>) {
  return withActor(request, async (actor) => {
    const collectionId = parse(Id, (await ctx.params).collectionId)
    const { schema, rows, truncated } = await Collections.listRows(actor, collectionId)
    return json({ schema, rows, truncated })
  })
}
