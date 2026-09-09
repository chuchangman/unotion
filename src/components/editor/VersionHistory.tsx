'use client'

/**
 * 버전 기록. 스냅샷 목록과 되돌리기.
 *
 * 스냅샷은 에디터가 저장 직전에 10분에 한 번 남긴다(Editor.tsx).
 * 그래서 목록의 각 항목은 "그 시각 편집을 시작하기 직전의 문서"다.
 */
import { useState, useTransition } from 'react'
import { History, RotateCcw, X } from 'lucide-react'
import { listVersions, restoreVersion } from '@/app/actions/pages'
import type { PageVersionMeta } from '@/lib/core/pages'

export function VersionHistory({ pageId, canEdit }: { pageId: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<PageVersionMeta[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [, start] = useTransition()

  const openPanel = () =>
    start(async () => {
      setOpen(true)
      setError('')
      const res = await listVersions(pageId)
      if (res.ok) setVersions(res.data)
      else setError(res.message)
    })

  const restore = (v: PageVersionMeta) => {
    const when = new Date(v.createdAt).toLocaleString('ko-KR')
    const ok = confirm(
      `${when} 상태로 되돌릴까요?\n지금 내용은 새 버전으로 먼저 저장되므로 다시 되돌릴 수 있습니다.`,
    )
    if (!ok) return

    start(async () => {
      setBusy(v.id)
      const res = await restoreVersion(pageId, v.id)
      setBusy(null)
      if (!res.ok) { setError(res.message); return }

      /**
       * 새로고침으로 되돌아간다.
       *
       * 에디터는 메모리에 자기 ydoc 을 들고 있어서, 그대로 두면 다음 자동저장이
       * 방금 되돌린 내용을 옛 상태로 덮어쓴다. router.refresh() 로는 그 ydoc 이
       * 새로 만들어지지 않으므로 문서를 통째로 다시 읽어야 한다.
       */
      window.location.reload()
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <History className="size-3.5" />
        기록
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button
            type="button"
            aria-label="기록 닫기"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-neutral-900/20"
          />

          <aside
            role="dialog"
            aria-label="버전 기록"
            className="relative flex h-full w-80 flex-col border-l border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
          >
            <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
              <h2 className="text-sm font-medium">버전 기록</h2>
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

              {versions === null ? (
                <p className="px-2 py-6 text-center text-sm text-neutral-400">불러오는 중…</p>
              ) : versions.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-neutral-400">
                  아직 저장된 버전이 없습니다.
                  <br />
                  편집하면 10분에 한 번씩 남습니다.
                </p>
              ) : (
                <ul className="space-y-1">
                  {versions.map((v) => (
                    <li
                      key={v.id}
                      className="group flex items-center justify-between gap-2 rounded-lg px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">
                          {new Date(v.createdAt).toLocaleString('ko-KR')}
                        </p>
                        <p className="truncate text-xs text-neutral-500">
                          {v.authorName ?? '알 수 없음'}
                          {v.title && ` · ${v.title}`}
                        </p>
                      </div>

                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => restore(v)}
                          disabled={busy === v.id}
                          aria-label={`${new Date(v.createdAt).toLocaleString('ko-KR')} 로 되돌리기`}
                          className="shrink-0 rounded p-1.5 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-900 focus:opacity-100 disabled:opacity-50 group-hover:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                        >
                          <RotateCcw className="size-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </>
  )
}
