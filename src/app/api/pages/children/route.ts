/**
 * 페이지 보드가 모든 칸의 하위 페이지 목록을 한 번에 가져온다.
 *   GET /api/pages/children?parents=<id>,<id>,...
 * 칸마다 부르면 칸 수만큼 왕복이 생긴다 (lib/core/pages.ts 의 listChildrenBatch).
 */
import { z } from 'zod'
import * as Pages from '@/lib/core/pages'
import { Id, parse } from '@/lib/validation'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

/** 보드 칸은 몇 개면 충분하다. 끝없는 목록으로 권한 검사를 돌리게 두지 않는다 */
const Parents = z.array(Id).min(1, '부모 페이지가 없습니다').max(20, '한 번에 20칸까지입니다')

export async function GET(request: Request) {
  return withActor(request, async (actor) => {
    const raw = new URL(request.url).searchParams.get('parents') ?? ''
    const parents = parse(Parents, raw.split(',').filter(Boolean))
    return json({ lists: await Pages.listChildrenBatch(actor, parents) })
  })
}
