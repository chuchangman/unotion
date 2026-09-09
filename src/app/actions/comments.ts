'use server'

/**
 * 코멘트 웹 어댑터. 로직은 없다 — lib/core/comments 를 부르고 직렬화만 한다.
 *
 * revalidatePath 를 쓰지 않는다. 코멘트는 사이드바 트리나 라우트 데이터를
 * 바꾸지 않으므로 라우트를 다시 그릴 이유가 없다. 패널이 응답값으로 갱신한다.
 */
import { requireActor } from '@/lib/auth'
import * as Comments from '@/lib/core/comments'
import * as Workspaces from '@/lib/core/workspaces'
import { DomainError } from '@/lib/core/errors'
import type { CommentRow, CommentThread } from '@/lib/core/comments'

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, code: err.code, message: err.message }
    }
    console.error('[action:comments] 예상치 못한 오류', err)
    return { ok: false, code: 'internal', message: '알 수 없는 오류가 발생했습니다' }
  }
}

export async function listThreads(
  pageId: string,
  includeResolved = false,
): Promise<ActionResult<CommentThread[]>> {
  return run(async () => {
    const actor = await requireActor()
    return Comments.listThreads(actor, pageId, { includeResolved })
  })
}

export async function createThread(
  pageId: string,
  body: string,
  mentions: string[] = [],
  blockId?: string | null,
): Promise<ActionResult<CommentRow>> {
  return run(async () => {
    const actor = await requireActor()
    return Comments.createThread(actor, pageId, { body, blockId, mentions })
  })
}

export async function replyToThread(
  threadId: string,
  body: string,
  mentions: string[] = [],
): Promise<ActionResult<CommentRow>> {
  return run(async () => {
    const actor = await requireActor()
    return Comments.reply(actor, threadId, body, mentions)
  })
}

/**
 * 멘션할 수 있는 사람들. 코멘트 입력창에서 @ 를 눌렀을 때만 부른다 —
 * 페이지 로드에 왕복을 하나 더 붙이지 않으려고 지연 조회한다.
 */
export async function listMentionables(
  workspaceId: string,
): Promise<ActionResult<Array<{ id: string; displayName: string; email: string }>>> {
  return run(async () => {
    const actor = await requireActor()
    const members = await Workspaces.listMembers(actor, workspaceId)
    return members.map((m) => ({ id: m.id, displayName: m.displayName, email: m.email }))
  })
}

export async function resolveThread(
  threadId: string,
  resolved: boolean,
): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Comments.resolveThread(actor, threadId, resolved)
    return null
  })
}

export async function deleteComment(commentId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Comments.deleteComment(actor, commentId)
    return null
  })
}
