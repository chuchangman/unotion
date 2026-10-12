'use server'

/**
 * 알림 웹 어댑터. 로직은 없다 — lib/core/notifications 를 부르고 직렬화만 한다.
 *
 * 발행(notify)은 여기 없다. 알림은 코멘트 같은 다른 동작의 부수효과로만 생기므로
 * 클라이언트가 직접 만들 수 있으면 안 된다 — 그러면 누구나 남에게 알림을 보낼 수 있다.
 *
 * 목록·안 읽은 수는 조회라 라우트다 — app/api/notifications
 */
import { z } from 'zod'
import { requireActor } from '@/lib/auth'
import * as Notifications from '@/lib/core/notifications'
import { run, type ActionResult } from '@/lib/action'
import { Id, parse } from '@/lib/validation'

export async function markRead(ids: string[]): Promise<ActionResult<null>> {
  return run('notifications', async () => {
    const valid = parse(z.array(Id).max(200), ids)
    const actor = await requireActor()
    await Notifications.markRead(actor, valid)
    return null
  })
}

export async function markAllRead(): Promise<ActionResult<null>> {
  return run('notifications', async () => {
    const actor = await requireActor()
    await Notifications.markAllRead(actor)
    return null
  })
}
