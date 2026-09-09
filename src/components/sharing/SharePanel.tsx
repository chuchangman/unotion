'use client'

/**
 * 페이지 공유. 멤버별로 이 페이지의 권한을 지정한다.
 *
 * 핵심은 "왜 이 권한인가"를 같이 보여주는 것이다 —
 * 워크스페이스 기본값인지, 상위 페이지에서 물려받은 것인지, 이 페이지에 직접
 * 건 것인지. 그게 안 보이면 권한을 바꿔도 왜 안 바뀌는지 알 수 없다.
 */
import { useState, useTransition } from 'react'
import { Share2, X } from 'lucide-react'
import * as Actions from '@/app/actions/sharing'
import type { PermissionLevel } from '@/lib/core/schema'
import type { SharingEntry } from '@/lib/core/sharing'

const LABEL: Record<PermissionLevel, string> = {
  read: '읽기',
  comment: '코멘트',
  edit: '편집',
  full: '전체',
}

/** 명시 권한을 지우고 기본값으로 되돌린다는 뜻 */
const INHERIT = '__inherit__'

export function SharePanel({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<SharingEntry[] | null>(null)
  const [error, setError] = useState('')
  const [, start] = useTransition()

  const openPanel = () =>
    start(async () => {
      setOpen(true)
      setError('')
      const res = await Actions.getPageSharing(pageId)
      if (res.ok) setEntries(res.data.entries)
      else setError(res.message)
    })

  const change = (entry: SharingEntry, value: string) =>
    start(async () => {
      const res =
        value === INHERIT
          ? await Actions.clearPagePermission(pageId, entry.userId)
          : await Actions.setPagePermission(pageId, entry.userId, value as PermissionLevel)

      if (!res.ok) { setError(res.message); return }

      // 서버가 규칙의 주인이다 — 바꾼 뒤 다시 읽어 상속/기본값 표시를 맞춘다
      const fresh = await Actions.getPageSharing(pageId)
      if (fresh.ok) setEntries(fresh.data.entries)
    })

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <Share2 className="size-3.5" />
        공유
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button
            type="button"
            aria-label="공유 닫기"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-neutral-900/20"
          />

          <aside
            role="dialog"
            aria-label="페이지 공유"
            className="relative flex h-full w-96 flex-col border-l border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
          >
            <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
              <h2 className="text-sm font-medium">페이지 공유</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="닫기"
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {error && <p className="px-2 py-1 text-sm text-red-600">{error}</p>}

              {entries === null ? (
                <p className="py-6 text-center text-sm text-neutral-400">불러오는 중…</p>
              ) : (
                <ul className="space-y-1">
                  {entries.map((e) => (
                    <li
                      key={e.userId}
                      className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{e.displayName}</p>
                        <p className="truncate text-[11px] text-neutral-500">
                          {e.explicitHere
                            ? '이 페이지에 지정됨'
                            : e.inheritedFrom
                              ? '상위 페이지에서 상속'
                              : `워크스페이스 ${e.role} 기본값`}
                        </p>
                      </div>

                      <select
                        value={e.explicitHere ?? INHERIT}
                        onChange={(ev) => change(e, ev.target.value)}
                        aria-label={`${e.displayName} 권한`}
                        className="shrink-0 rounded border border-neutral-200 bg-transparent px-1.5 py-1 text-xs dark:border-neutral-700"
                      >
                        <option value={INHERIT}>
                          기본 ({e.effective ? LABEL[e.effective] : '접근 불가'})
                        </option>
                        {(Object.keys(LABEL) as PermissionLevel[]).map((lv) => (
                          <option key={lv} value={lv}>{LABEL[lv]}</option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400 dark:border-neutral-800">
              여기서 준 권한은 하위 페이지에도 상속됩니다. &ldquo;기본&rdquo;으로 되돌리면
              차단이 아니라 워크스페이스 기본값으로 돌아갑니다.
            </p>
          </aside>
        </div>
      )}
    </>
  )
}
