'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Maximize2, X } from 'lucide-react'
import { getPagePreview } from '@/app/actions/pages'
import { PageHeader } from './PageHeader'
import { EditorLoader } from './EditorLoader'

type Preview = {
  id: string
  title: string
  icon: { type: 'emoji' | 'url'; value: string } | null
  canEdit: boolean
}

/**
 * 우측 미리보기 패널 (노션의 side peek).
 *
 * 상태를 ?peek=<pageId> 로 URL 에 둔다 — 새로고침해도 유지되고,
 * 뒤로가기로 닫히며, 그 상태 그대로 링크를 공유할 수 있다.
 */
export function PeekPanel({
  workspaceId,
  user,
}: {
  workspaceId: string
  user: { id: string; name: string }
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const peekId = params.get('peek')

  const [page, setPage] = useState<Preview | null>(null)
  const [error, setError] = useState('')

  const close = useCallback(() => {
    const next = new URLSearchParams(params.toString())
    next.delete('peek')
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [params, pathname, router])

  const openFull = useCallback(() => {
    if (peekId) router.push(`/p/${peekId}`)
  }, [peekId, router])

  useEffect(() => {
    if (!peekId) { setPage(null); setError(''); return }
    let cancelled = false
    setPage(null)
    setError('')
    void getPagePreview(peekId).then((res) => {
      if (cancelled) return
      if (res.ok) setPage(res.data)
      else setError(res.message)
    })
    return () => { cancelled = true }
  }, [peekId])

  useEffect(() => {
    if (!peekId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [peekId, close])

  if (!peekId) return null

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 dark:bg-black/40"
        onClick={close}
        aria-hidden
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="페이지 미리보기"
        className="peek-panel fixed right-0 top-0 z-50 flex h-dvh w-full max-w-2xl flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <button
            type="button"
            onClick={openFull}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Maximize2 className="size-3.5" />
            전체 페이지로 열기
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="닫기"
            className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-10 py-8">
          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {error}
            </p>
          )}

          {!page && !error && (
            <div className="space-y-3">
              <div className="h-8 w-1/2 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
            </div>
          )}

          {page && (
            /* key 로 페이지가 바뀔 때 에디터와 Yjs 문서를 확실히 새로 만든다 */
            <div key={page.id}>
              <PageHeader
                pageId={page.id}
                initialTitle={page.title}
                icon={page.icon}
                canEdit={page.canEdit}
              />
              <EditorLoader
                pageId={page.id}
                workspaceId={workspaceId}
                title={page.title}
                user={user}
                canEdit={page.canEdit}
              />
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
