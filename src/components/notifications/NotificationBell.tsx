'use client'

/**
 * 알림 종. 사이드바에 붙는다.
 *
 * 안 읽은 개수는 서버에서 미리 받아 온다(레이아웃이 한 번 세어 준다).
 * 목록은 종을 눌렀을 때만 불러온다 — 알림을 안 보는 사람에게 왕복을 물리지 않는다.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AtSign, Bell, MessageSquare, UserPlus } from 'lucide-react'
import * as Actions from '@/app/actions/notifications'
import type { NotificationRow } from '@/lib/core/notifications'

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
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationRow[] | null>(null)
  const [unread, setUnread] = useState(initialUnread)
  const [, start] = useTransition()

  const openPanel = () =>
    start(async () => {
      setOpen(true)
      const res = await Actions.listNotifications()
      if (res.ok) setItems(res.data)
    })

  const readAll = () =>
    start(async () => {
      const res = await Actions.markAllRead()
      if (!res.ok) return
      setUnread(0)
      setItems((prev) => (prev ?? []).map((n) => ({ ...n, readAt: n.readAt ?? new Date() })))
    })

  const openItem = (n: NotificationRow) =>
    start(async () => {
      if (!n.readAt) {
        await Actions.markRead([n.id])
        setUnread((u) => Math.max(0, u - 1))
        setItems((prev) =>
          (prev ?? []).map((x) => (x.id === n.id ? { ...x, readAt: new Date() } : x)),
        )
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
