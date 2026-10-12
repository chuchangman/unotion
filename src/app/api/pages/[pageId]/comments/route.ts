/**
 * 페이지의 코멘트 스레드 (CommentPanel).
 *   GET ?resolved=1  해결된 스레드까지
 * 쓰기(작성·답글·해결·삭제)는 계속 서버 액션이다 (app/actions/comments.ts).
 */
import * as Comments from '@/lib/core/comments'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: RouteContext<'/api/pages/[pageId]/comments'>) {
  return withActor(request, async (actor) => {
    const pageId = parse(Id, (await ctx.params).pageId)
    const includeResolved = new URL(request.url).searchParams.get('resolved') === '1'
    return json({ threads: await Comments.listThreads(actor, pageId, { includeResolved }) })
  })
}
