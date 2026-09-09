/**
 * 코멘트 도메인.
 *
 * 모델은 **스레드**다. comments.thread_id 가 스레드를 묶고, 스레드의 첫 글은
 * 자기 id 를 thread_id 로 갖는다. block_id 는 인라인 코멘트가 걸린 블록이고
 * 페이지 전체에 다는 코멘트면 null 이다.
 *
 * 권한은 permissions.ts 의 comment 레벨을 쓴다 — read < comment < edit < full.
 * 즉 편집 권한이 없어도 의견은 남길 수 있다. 그러라고 있는 레벨이다.
 *
 * 규칙은 pages.ts 와 같다: 모든 export 함수는 첫 인자로 Actor 를 받고
 * 가장 먼저 assert* 를 호출한다.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from './db'
import { comments, profiles, workspaceMembers } from './schema'
import { Forbidden, InvalidInput, NotFound } from './errors'
import { assertCanComment, assertCanRead, resolvePageAccess } from './permissions'
import * as audit from './audit'
import * as Notifications from './notifications'
import type { Actor } from './actor'

export type CommentRow = {
  id: string
  threadId: string
  blockId: string | null
  body: string
  authorId: string
  authorName: string | null
  createdAt: Date
  resolvedAt: Date | null
}

export type CommentThread = {
  id: string
  blockId: string | null
  resolvedAt: Date | null
  comments: CommentRow[]
}

/** 코멘트 본문 상한. 이보다 길면 페이지에 쓰라는 뜻이다. */
const MAX_BODY = 4000

const SELECT = {
  id: comments.id,
  threadId: comments.threadId,
  blockId: comments.blockId,
  body: comments.body,
  authorId: comments.authorId,
  authorName: profiles.displayName,
  createdAt: comments.createdAt,
  resolvedAt: comments.resolvedAt,
}

function normalizeBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) throw new InvalidInput('내용을 입력하세요')
  if (trimmed.length > MAX_BODY) {
    throw new InvalidInput(`코멘트가 너무 깁니다 (최대 ${MAX_BODY.toLocaleString()}자)`)
  }
  return trimmed
}

/** 스레드가 어느 페이지에 있는지 — 권한 검사의 기준점 */
async function pageIdOfThread(threadId: string): Promise<string> {
  const [row] = await db
    .select({ pageId: comments.pageId })
    .from(comments)
    .where(eq(comments.threadId, threadId))
    .limit(1)
  if (!row) throw new NotFound('Comment thread')
  return row.pageId
}

/**
 * 코멘트가 등록된 뒤의 알림 발행.
 *
 * 두 종류를 보낸다:
 *   - mention  : 글쓴이가 직접 지목한 사람
 *   - comment  : 그 스레드에 이미 참여한 사람 (지목당한 사람과 중복되면 mention 이 이긴다)
 *
 * 멘션 대상은 **이 워크스페이스 멤버로 제한**한다. 검증하지 않으면 남의 워크스페이스
 * 사용자 id 를 넣어 그 사람에게 우리 페이지 제목이 담긴 알림을 보낼 수 있다.
 */
async function fanOut(
  actor: Actor,
  input: {
    workspaceId: string
    pageId: string
    threadId: string
    body: string
    mentions: string[]
  },
): Promise<void> {
  const excerpt = input.body.slice(0, 140)

  let mentioned: string[] = []
  if (input.mentions.length > 0) {
    const rows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        inArray(workspaceMembers.userId, [...new Set(input.mentions)]),
      ))
    mentioned = rows.map((r) => r.userId)
  }

  const participants = await db
    .selectDistinct({ authorId: comments.authorId })
    .from(comments)
    .where(eq(comments.threadId, input.threadId))

  const others = participants
    .map((p) => p.authorId)
    .filter((id) => !mentioned.includes(id))

  await Promise.all([
    Notifications.notify(actor, {
      userIds: mentioned,
      type: 'mention',
      pageId: input.pageId,
      payload: { threadId: input.threadId, excerpt },
    }),
    Notifications.notify(actor, {
      userIds: others,
      type: 'comment',
      pageId: input.pageId,
      payload: { threadId: input.threadId, excerpt },
    }),
  ])
}

async function loadOne(id: string): Promise<CommentRow> {
  const [row] = await db
    .select(SELECT)
    .from(comments)
    .leftJoin(profiles, eq(profiles.id, comments.authorId))
    .where(eq(comments.id, id))
    .limit(1)
  if (!row) throw new NotFound('Comment')
  return row
}

/**
 * 페이지의 코멘트 스레드.
 * 기본은 미해결만 준다 — 해결된 스레드까지 늘 보이면 패널이 금방 쓸모없어진다.
 */
export async function listThreads(
  actor: Actor,
  pageId: string,
  opts: { includeResolved?: boolean } = {},
): Promise<CommentThread[]> {
  await assertCanRead(actor.userId, pageId)

  const rows = await db
    .select(SELECT)
    .from(comments)
    .leftJoin(profiles, eq(profiles.id, comments.authorId))
    .where(
      opts.includeResolved
        ? eq(comments.pageId, pageId)
        : and(eq(comments.pageId, pageId), isNull(comments.resolvedAt)),
    )
    .orderBy(asc(comments.createdAt))

  const byThread = new Map<string, CommentThread>()
  for (const r of rows) {
    let thread = byThread.get(r.threadId)
    if (!thread) {
      thread = { id: r.threadId, blockId: r.blockId, resolvedAt: r.resolvedAt, comments: [] }
      byThread.set(r.threadId, thread)
    }
    thread.comments.push(r)
  }
  return [...byThread.values()]
}

export async function createThread(
  actor: Actor,
  pageId: string,
  input: { body: string; blockId?: string | null; mentions?: string[] },
): Promise<CommentRow> {
  const access = await assertCanComment(actor.userId, pageId)
  const body = normalizeBody(input.body)

  // 스레드의 첫 글은 자기 id 를 thread_id 로 갖는다
  const id = randomUUID()
  await db.insert(comments).values({
    id,
    pageId,
    threadId: id,
    blockId: input.blockId ?? null,
    authorId: actor.userId,
    body,
  })

  await fanOut(actor, {
    workspaceId: access.workspaceId,
    pageId,
    threadId: id,
    body,
    mentions: input.mentions ?? [],
  })

  await audit.record(actor, 'comment.create', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { threadId: id },
  })
  return loadOne(id)
}

export async function reply(
  actor: Actor,
  threadId: string,
  body: string,
  mentions: string[] = [],
): Promise<CommentRow> {
  const pageId = await pageIdOfThread(threadId)
  const access = await assertCanComment(actor.userId, pageId)
  const text = normalizeBody(body)

  const [root] = await db
    .select({ blockId: comments.blockId })
    .from(comments)
    .where(eq(comments.id, threadId))
    .limit(1)

  const id = randomUUID()
  await db.insert(comments).values({
    id,
    pageId,
    threadId,
    blockId: root?.blockId ?? null,
    authorId: actor.userId,
    body: text,
  })

  // 참여자 계산이 이 답글까지 포함하도록 삽입 뒤에 부른다
  await fanOut(actor, {
    workspaceId: access.workspaceId,
    pageId,
    threadId,
    body: text,
    mentions,
  })

  await audit.record(actor, 'comment.reply', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { threadId },
  })
  return loadOne(id)
}

/**
 * 스레드 해결 / 재개.
 *
 * 스레드의 **모든 행**에 표시한다. 루트에만 두면 목록 질의가 스레드마다
 * 루트를 따로 찾아야 하고, 루트가 지워진 스레드에서 상태가 사라진다.
 */
export async function resolveThread(
  actor: Actor,
  threadId: string,
  resolved: boolean,
): Promise<void> {
  const pageId = await pageIdOfThread(threadId)
  const access = await assertCanComment(actor.userId, pageId)

  await db.update(comments)
    .set({
      resolvedAt: resolved ? new Date() : null,
      resolvedBy: resolved ? actor.userId : null,
    })
    .where(eq(comments.threadId, threadId))

  await audit.record(actor, resolved ? 'comment.resolve' : 'comment.reopen', {
    workspaceId: access.workspaceId, targetId: pageId, meta: { threadId },
  })
}

/**
 * 코멘트 삭제. **본인 글이거나 페이지를 관리(full)할 수 있어야 한다.**
 * 스레드의 첫 글을 지우면 답글까지 함께 사라진다 — 맥락 없는 답글만 남기지 않는다.
 */
export async function deleteComment(actor: Actor, commentId: string): Promise<void> {
  const [row] = await db
    .select({
      id: comments.id,
      pageId: comments.pageId,
      threadId: comments.threadId,
      authorId: comments.authorId,
    })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)
  if (!row) throw new NotFound('Comment')

  const access = await resolvePageAccess(actor.userId, row.pageId)
  if (!access) throw new Forbidden('이 페이지에 접근할 수 없습니다')

  const isAuthor = row.authorId === actor.userId
  if (!isAuthor && access.level !== 'full') {
    throw new Forbidden('본인이 쓴 코멘트만 지울 수 있습니다')
  }

  const isRoot = row.id === row.threadId
  await db.delete(comments).where(
    isRoot ? eq(comments.threadId, row.threadId) : eq(comments.id, commentId),
  )

  await audit.record(actor, 'comment.delete', {
    workspaceId: access.workspaceId,
    targetId: row.pageId,
    meta: { threadId: row.threadId, wholeThread: isRoot },
  })
}

/** 페이지의 미해결 스레드 수 — 헤더 배지에 쓴다 */
export async function countOpenThreads(actor: Actor, pageId: string): Promise<number> {
  await assertCanRead(actor.userId, pageId)
  const rows = await db
    .selectDistinct({ threadId: comments.threadId })
    .from(comments)
    .where(and(eq(comments.pageId, pageId), isNull(comments.resolvedAt)))
  return rows.length
}
