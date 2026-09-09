/**
 * 알림 도메인.
 *
 * 발행(notify)은 **다른 도메인 안에서** 불린다 — 코멘트에서 누가 나를 멘션했다든지.
 * 그래서 발행 함수만 Actor 관례에서 살짝 벗어난다: 받는 사람 기준의 권한 검사가 아니라
 * 이미 권한을 통과한 동작의 부수효과이기 때문이다.
 * 읽기 / 읽음 처리는 **본인 것만** 만질 수 있다 (user_id 조건이 항상 붙는다).
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from './db'
import { notifications, pages, profiles } from './schema'
import type { Actor } from './actor'

export type NotificationType = 'mention' | 'comment' | 'invite'

export type NotificationRow = {
  id: string
  type: string
  pageId: string | null
  pageTitle: string | null
  actorId: string | null
  actorName: string | null
  payload: unknown
  readAt: Date | null
  createdAt: Date
}

/**
 * 알림을 만든다.
 *
 * - 자기 자신에게는 보내지 않는다 (내가 나를 멘션해도 알림은 무의미하다)
 * - 대상이 그 페이지를 볼 수 있는지는 호출부가 보장한다. 멘션 대상은 워크스페이스
 *   멤버로 제한되므로 여기서 다시 확인하지 않는다.
 */
export async function notify(
  actor: Actor,
  input: {
    userIds: string[]
    type: NotificationType
    pageId?: string | null
    payload?: Record<string, unknown>
  },
): Promise<number> {
  const targets = [...new Set(input.userIds)].filter((id) => id && id !== actor.userId)
  if (targets.length === 0) return 0

  await db.insert(notifications).values(
    targets.map((userId) => ({
      userId,
      type: input.type,
      pageId: input.pageId ?? null,
      actorId: actor.userId,
      payload: input.payload ?? {},
    })),
  )
  return targets.length
}

/** 내 알림 목록. 남의 알림은 애초에 조회되지 않는다. */
export async function listForUser(
  actor: Actor,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<NotificationRow[]> {
  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      pageId: notifications.pageId,
      pageTitle: pages.title,
      actorId: notifications.actorId,
      actorName: profiles.displayName,
      payload: notifications.payload,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    // 페이지 없는 알림(초대 등)도 있으므로 LEFT JOIN 이다
    .leftJoin(pages, eq(pages.id, notifications.pageId))
    .leftJoin(profiles, eq(profiles.id, notifications.actorId))
    .where(
      opts.unreadOnly
        ? and(eq(notifications.userId, actor.userId), isNull(notifications.readAt))
        : eq(notifications.userId, actor.userId),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 30)
}

export async function countUnread(actor: Actor): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)))
  return rows.length
}

export async function markRead(actor: Actor, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.update(notifications)
    .set({ readAt: new Date() })
    .where(and(
      eq(notifications.userId, actor.userId),
      inArray(notifications.id, ids),
      isNull(notifications.readAt),
    ))
}

export async function markAllRead(actor: Actor): Promise<void> {
  await db.update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)))
}
