/**
 * ⌘K 검색 (SearchPalette). 조회라서 서버 액션이 아니다 — 액션은 클라이언트당 한 줄로 서서
 * 자동저장이나 다른 조회 뒤에서 기다린다 (components/providers/QueryProvider.tsx 주석).
 */
import { z } from 'zod'
import * as Pages from '@/lib/core/pages'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

const Q = z.string().trim().max(200, '검색어가 너무 깁니다')

export async function GET(request: Request, ctx: RouteContext<'/api/workspaces/[workspaceId]/search'>) {
  return withActor(request, async (actor) => {
    const workspaceId = parse(Id, (await ctx.params).workspaceId)
    const q = parse(Q, new URL(request.url).searchParams.get('q') ?? '')
    return json({ hits: await Pages.searchPages(actor, workspaceId, q) })
  })
}
