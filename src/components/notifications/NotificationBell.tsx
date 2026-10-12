'use client'

/**
 * 알림 종. 사이드바에 붙는다.
 *
 * 안 읽은 개수는 서버에서 미리 받아 온다(레이아웃이 한 번 세어 준다).
 * 목록은 종을 눌렀을 때만 불러온다 — 알림을 안 보는 사람에게 왕복을 물리지 않는다.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AtSign, Bell, MessageSquare, UserPlus } from 'lucide-react'
import * as Actions from '@/app/actions/notifications'
import type { NotificationRow } from '@/lib/core/notifications'
import { getJson, type Jsonified } from '@/lib/api/client'
import { qk } from '@/lib/query-keys'

type Item = Jsonified<NotificationRow>

const ICON = {
  mention: AtSign,
  comment: MessageSquare,
  invite: UserPlus,
} as const

const VERB: Record<string, string> = {
  mention: '님이 회원님을 언급했습니다',
  comment: '님이 댓글을 남겼습니다',
  invite: '님이 초대했습니다',
}

export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [, start] = useTransition()

  /**
   * 안 읽은 수는 레이아웃이 세어 준 값으로 시작한다(왕복 없음). 누가 나를 멘션했다는
   * 실시간 신호가 오면 이 키만 무효화해 다시 센다 (components/live/WorkspaceLive.tsx).
   */
  const unreadQuery = useQuery({
    queryKey: qk.unread,
    queryFn: () => getJson<{ unread: number }>('/api/notifications?count=1').then((r) => r.unread),
    initialData: initialUnread,
  })
  const unread = unreadQuery.data

  // 목록은 종을 눌렀을 때만 불러온다
  const itemsQuery = useQuery({
    queryKey: qk.notifications,
    queryFn: () => getJson<{ items: Item[] }>('/api/notifications').then((r) => r.items),
    enabled: open,
  })
  const items = itemsQuery.data ?? null

  const setItems = (fn: (prev: Item[]) => Item[]) =>
    queryClient.setQueryData<Item[]>(qk.notifications, (prev) => fn(prev ?? []))
  const setUnread = (fn: (prev: number) => number) =>
    queryClient.setQueryData<number>(qk.unread, (prev) => fn(prev ?? 0))

  const openPanel = () => setOpen(true)

  const readAll = () =>
    start(async () => {
      const res = await Actions.markAllRead()
      if (!res.ok) return
      const now = new Date().toISOString()
      setUnread(() => 0)
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? now })))
    })

  const openItem = (n: Item) =>
    start(async () => {
      if (!n.readAt) {
        await Actions.markRead([n.id])
        const now = new Date().toISOString()
        setUnread((u) => Math.max(0, u - 1))
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: now } : x)))
      }
      setOpen(false)
      if (n.pageId) router.push(`/p/${n.pageId}`)
    })

  return (
    <div className="relative">
      <button
        type="button"
        onClick={openPanel}
        aria-label={unread > 0 ? `알림 ${unread}건` : '알림'}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        <Bell className="size-4" />
        알림
        {unread > 0 && (
          <span className="ml-auto rounded-full bg-red-500 px-1.5 text-[10px] font-medium text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="알림 닫기"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div className="absolute bottom-full left-0 z-40 mb-1 max-h-96 w-80 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
            <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              <span className="text-xs font-medium">알림</span>
              {unread > 0 && (
                <button
                  type="button"
                  onClick={readAll}
                  className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  모두 읽음
                </button>
              )}
            </div>

            {items === null ? (
              <p className="px-3 py-6 text-center text-sm text-neutral-400">불러오는 중…</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-neutral-400">알림이 없습니다.</p>
            ) : (
              <ul className="p-1">
                {items.map((n) => {
                  const Icon = ICON[n.type as keyof typeof ICON] ?? Bell
                  const excerpt = (n.payload as { excerpt?: string } | null)?.excerpt
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => openItem(n)}
                        className={
                          'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ' +
                          (n.readAt ? 'opacity-60' : '')
                        }
                      >
                        <Icon className="mt-0.5 size-3.5 shrink-0 text-neutral-400" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">
                            <span className="font-medium">{n.actorName ?? '알 수 없음'}</span>
                            {VERB[n.type] ?? ''}
                          </span>
                          {n.pageTitle !== null && (
                            <span className="block truncate text-[11px] text-neutral-500">
                              {n.pageTitle || '제목 없음'}
                            </span>
                          )}
                          {excerpt && (
                            <span className="block truncate text-[11px] text-neutral-400">
                              {excerpt}
                            </span>
                          )}
                        </span>
                        {!n.readAt && (
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-red-500" />
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
