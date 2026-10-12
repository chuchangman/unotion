/**
 * 우측 미리보기 패널(PeekPanel)이 페이지를 열 때 필요한 최소 정보.
 * 본문은 에디터가 ydoc 라우트로 따로 받는다.
 */
import * as Pages from '@/lib/core/pages'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: RouteContext<'/api/pages/[pageId]/preview'>) {
  return withActor(request, async (actor) => {
    const pageId = parse(Id, (await ctx.params).pageId)
    const meta = await Pages.getPageMeta(actor, pageId)
    return json({
      id: meta.id,
      title: meta.title,
      icon: meta.icon,
      canEdit: meta.level === 'edit' || meta.level === 'full',
    })
  })
}
