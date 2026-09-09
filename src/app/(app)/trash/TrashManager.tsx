'use client'

/**
 * 휴지통. 되살리기와 영구 삭제.
 *
 * 목록에는 "지우기를 실행한 그 페이지"만 나온다 — 함께 딸려 들어간 하위 페이지는
 * 개수로만 보여준다. 자식만 따로 되살리면 부모가 여전히 휴지통에 있어
 * 트리 어디에도 안 나타나기 때문이다.
 */
import { useState, useTransition } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { deletePagePermanently, restorePage } from '@/app/actions/pages'
import type { TrashedPage } from '@/lib/core/pages'

export function TrashManager({
  items, canPurge,
}: {
  items: TrashedPage[]
  canPurge: boolean
}) {
  const [rows, setRows] = useState(items)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [, start] = useTransition()

  const restore = (page: TrashedPage) =>
    start(async () => {
      setBusy(page.id)
      const res = await restorePage(page.id)
      setBusy(null)
      if (res.ok) setRows((prev) => prev.filter((r) => r.id !== page.id))
      else setError(res.message)
    })

  const purge = (page: TrashedPage) => {
    const extra = page.descendants > 0
      ? ` 하위 페이지 ${page.descendants}개도 함께 사라집니다.`
      : ''
    if (!confirm(`"${page.title}" 을 영구 삭제할까요? 되돌릴 수 없습니다.${extra}`)) return

    start(async () => {
      setBusy(page.id)
      const res = await deletePagePermanently(page.id)
      setBusy(null)
      if (res.ok) setRows((prev) => prev.filter((r) => r.id !== page.id))
      else setError(res.message)
    })
  }

  if (rows.length === 0) {
    return (
      <p className="mt-8 rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-400 dark:border-neutral-700">
        휴지통이 비어 있습니다.
      </p>
    )
  }

  return (
    <div className="mt-8">
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {rows.map((page) => (
          <li key={page.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {page.icon?.type === 'emoji' && <span className="mr-1.5">{page.icon.value}</span>}
                {page.title}
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {page.trashedAt
                  ? `${new Date(page.trashedAt).toLocaleString('ko-KR')} 삭제`
                  : '삭제 시각 없음'}
                {page.descendants > 0 && ` · 하위 ${page.descendants}개 포함`}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => restore(page)}
                disabled={busy === page.id}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                <RotateCcw className="size-4" />
                되살리기
              </button>

              {canPurge && (
                <button
                  type="button"
                  onClick={() => purge(page)}
                  disabled={busy === page.id}
                  aria-label={`${page.title} 영구 삭제`}
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-800"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!canPurge && (
        <p className="mt-3 text-xs text-neutral-400">
          영구 삭제는 워크스페이스 관리자만 할 수 있습니다.
        </p>
      )}
    </div>
  )
}
