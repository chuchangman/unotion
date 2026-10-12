'use server'

/**
 * 코멘트 웹 어댑터. 로직은 없다 — lib/core/comments 를 부르고 직렬화만 한다.
 *
 * revalidatePath 를 쓰지 않는다. 코멘트는 사이드바 트리나 라우트 데이터를
 * 바꾸지 않으므로 라우트를 다시 그릴 이유가 없다. 패널이 응답값으로 갱신한다.
 *
 * 목록과 멘션 후보는 조회라 라우트다 — app/api/pages/[pageId]/comments,
 * app/api/workspaces/[workspaceId]/members
 */
import { z } from 'zod'
import { requireActor } from '@/lib/auth'
import * as Comments from '@/lib/core/comments'
import type { CommentRow } from '@/lib/core/comments'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

/** 길이 상한은 core 가 본다 (comments.ts 의 MAX_BODY). 여기서는 문자열인지만 */
const Body = z.string()
/** 멘션은 워크스페이스 멤버로 core 가 다시 거른다 */
const Mentions = z.array(Id).max(50, '한 번에 50명까지 멘션할 수 있습니다')

export async function createThread(
  pageId: string,
  body: string,
  mentions: string[] = [],
  blockId?: string | null,
): Promise<ActionResult<CommentRow>> {
  return run('comments', async () => {
    const id = parse(Id, pageId)
    const input = {
      body: parse(Body, body),
      mentions: parse(Mentions, mentions),
      // BlockNote 블록 id. 인라인 코멘트용이다
      blockId: parse(z.string().max(100).nullable().optional(), blockId),
    }
    const actor = await requireActor()
    return Comments.createThread(actor, id, input)
  })
}

export async function replyToThread(
  threadId: string,
  body: string,
  mentions: string[] = [],
): Promise<ActionResult<CommentRow>> {
  return run('comments', async () => {
    const id = parse(Id, threadId)
    const actor = await requireActor()
    return Comments.reply(actor, id, parse(Body, body), parse(Mentions, mentions))
  })
}

export async function resolveThread(
  threadId: string,
  resolved: boolean,
): Promise<ActionResult<null>> {
  return run('comments', async () => {
    const id = parse(Id, threadId)
    const actor = await requireActor()
    await Comments.resolveThread(actor, id, parse(z.boolean(), resolved))
    return null
  })
}

export async function deleteComment(commentId: string): Promise<ActionResult<null>> {
  return run('comments', async () => {
    const id = parse(Id, commentId)
    const actor = await requireActor()
    await Comments.deleteComment(actor, id)
    return null
  })
}
