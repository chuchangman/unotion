/**
 * 내 알림 (NotificationBell).
 *   GET          목록 (최근 30개)
 *   GET ?count=1 안 읽은 수만 — 누가 나를 멘션했다는 실시간 신호를 받으면 이것만 다시 센다
 * 읽음 처리는 계속 서버 액션이다 (app/actions/notifications.ts).
 */
import * as Notifications from '@/lib/core/notifications'
import { json, withActor } from '@/lib/api/route'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return withActor(request, async (actor) => {
    if (new URL(request.url).searchParams.get('count') === '1') {
      return json({ unread: await Notifications.countUnread(actor) })
    }
    return json({ items: await Notifications.listForUser(actor) })
  })
}
