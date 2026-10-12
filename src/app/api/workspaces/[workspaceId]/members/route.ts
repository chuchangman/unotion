/**
 * 멘션할 수 있는 사람들 (코멘트 입력창에서 @ 를 눌렀을 때만 부른다).
 * 멤버 목록은 거의 안 바뀌므로 Query 캐시가 패널을 다시 열 때의 왕복을 없앤다.
 */
import * as Workspaces from '@/lib/core/workspaces'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: RouteContext<'/api/workspaces/[workspaceId]/members'>) {
  return withActor(request, async (actor) => {
    const workspaceId = parse(Id, (await ctx.params).workspaceId)
    const members = await Workspaces.listMembers(actor, workspaceId)
    return json({
      members: members.map((m) => ({ id: m.id, displayName: m.displayName, email: m.email })),
    })
  })
}
