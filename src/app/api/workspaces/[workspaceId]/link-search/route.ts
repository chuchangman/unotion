/**
 * 본문에서 @ 로 페이지를 링크할 때의 검색 (아이콘 포함, 발췌 없음).
 * 키 입력마다 불리므로 액션 줄에 세우면 체감이 바로 온다 — 그래서 라우트다.
 */
import { z } from 'zod'
import * as Pages from '@/lib/core/pages'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

const Q = z.string().max(200, '검색어가 너무 깁니다')

export async function GET(request: Request, ctx: RouteContext<'/api/workspaces/[workspaceId]/link-search'>) {
  return withActor(request, async (actor) => {
    const workspaceId = parse(Id, (await ctx.params).workspaceId)
    const q = parse(Q, new URL(request.url).searchParams.get('q') ?? '')
    return json({ pages: await Pages.searchPagesForLink(actor, workspaceId, q) })
  })
}
