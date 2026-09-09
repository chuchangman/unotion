'use server'

/**
 * 알림 웹 어댑터. 로직은 없다 — lib/core/notifications 를 부르고 직렬화만 한다.
 *
 * 발행(notify)은 여기 없다. 알림은 코멘트 같은 다른 동작의 부수효과로만 생기므로
 * 클라이언트가 직접 만들 수 있으면 안 된다 — 그러면 누구나 남에게 알림을 보낼 수 있다.
 */
import { requireActor } from '@/lib/auth'
import * as Notifications from '@/lib/core/notifications'
import { DomainError } from '@/lib/core/errors'
import type { NotificationRow } from '@/lib/core/notifications'

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
    console.error('[action:notifications] 예상치 못한 오류', err)
    return { ok: false, code: 'internal', message: '알 수 없는 오류가 발생했습니다' }
  }
}

export async function listNotifications(
  unreadOnly = false,
): Promise<ActionResult<NotificationRow[]>> {
  return run(async () => {
    const actor = await requireActor()
    return Notifications.listForUser(actor, { unreadOnly })
  })
}

export async function markRead(ids: string[]): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Notifications.markRead(actor, ids)
    return null
  })
}

export async function markAllRead(): Promise<ActionResult<null>> {
  return run(async () => {
    const actor = await requireActor()
    await Notifications.markAllRead(actor)
    return null
  })
}
