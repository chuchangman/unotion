/**
 * 검색창을 막 열었을 때(검색어가 없을 때) 보여줄 최근 문서.
 * 빈 화면보다 낫다 — 실제로 찾는 문서의 상당수가 방금 보던 것이다.
 *
 * getRecentChanges 를 그대로 쓴다. "언제부터"가 아니라 "최근 N개"가 필요하므로
 * 시작점은 epoch 로 두고 정렬(updated_at DESC)과 limit 에 맡긴다.
 */
import * as Pages from '@/lib/core/pages'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: RouteContext<'/api/workspaces/[workspaceId]/recent'>) {
  return withActor(request, async (actor) => {
    const workspaceId = parse(Id, (await ctx.params).workspaceId)
    const rows = await Pages.getRecentChanges(actor, workspaceId, new Date(0), 8)
    return json({ pages: rows.map((r) => ({ id: r.id, title: r.title || '제목 없음' })) })
  })
}
