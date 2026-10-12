'use client'

/**
 * "이동…" — 페이지를 다른 페이지 밑(또는 최상위)으로 옮긴다.
 *
 * 끌어서 놓기(PageTree)와 같은 일을 하지만 키보드와 터치로도 된다. 트리 DnD 는 마우스
 * 전용이고 긴 트리에서는 목적지까지 끌고 가기가 어렵다 — 이쪽이 기본 경로다.
 * 자기 자신과 그 하위는 목록에서 뺀다 (서버도 막는다).
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FileText, X } from 'lucide-react'
import type { TreeNode } from '@/lib/core/pages'
import { flatten, subtreeIds, type ByParent } from '@/lib/page-tree'

export function MovePageDialog({
  page, byParent, allowRoot, onPick, onClose,
}: {
  page: TreeNode
  byParent: ByParent
  /** 최상위로 옮길 수 있는지. 게스트는 못 한다 (lib/core/pages.ts 의 movePage) */
  allowRoot: boolean
  /** null 이면 최상위 */
  onPick: (parentId: string | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const title = page.title || '제목 없음'

  const options = useMemo(() => {
    const locked = subtreeIds(byParent, page.id)
    return flatten(byParent).filter(({ node }) => !locked.has(node.id))
  }, [byParent, page.id])

  const q = query.trim().toLowerCase()
  const shown = q
    ? options.filter(({ node }) => (node.title || '제목 없음').toLowerCase().includes(q))
    : options

  const dialogRef = useRef<HTMLDivElement>(null)
  /**
   * 닫히면 연 자리(행의 "옮기기" 버튼)로 포커스를 돌려준다. 이펙트 정리 함수에서 하면
   * 개발 중 StrictMode 의 이중 실행이 열자마자 포커스를 되돌려서, 닫는 길마다 직접 부른다.
   */
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  const close = () => {
    onClose()
    opener?.focus()
  }
  const pick = (parentId: string | null) => {
    onPick(parentId)
    opener?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'Tab') return
    // 포커스를 대화상자 안에 가둔다 — Tab 이 뒤의 사이드바로 빠져나가지 않게
    const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input')
    if (!items || items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label="닫기"
        onClick={close}
        tabIndex={-1}
        className="fixed inset-0 cursor-default bg-neutral-900/30"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`"${title}" 옮기기`}
        className="relative flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="text-neutral-500">옮기기 · </span>
            <strong className="font-medium">{title}</strong>
          </span>
          <button
            type="button"
            onClick={close}
            aria-label="닫기"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X className="size-4" />
          </button>
        </header>

        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="옮길 곳 찾기"
          aria-label="옮길 곳 찾기"
          className="border-b border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none dark:border-neutral-800"
        />

        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {!q && allowRoot && page.parentId !== null && (
            <li>
              <button
                type="button"
                onClick={() => pick(null)}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                최상위로
              </button>
            </li>
          )}
          {shown.map(({ node, depth }) => {
            const here = node.id === page.parentId
            return (
              <li key={node.id}>
                <button
                  type="button"
                  disabled={here}
                  onClick={() => pick(node.id)}
                  style={{ paddingLeft: 8 + (q ? 0 : depth * 14) }}
                  className="flex w-full items-center gap-1.5 rounded py-1.5 pr-2 text-left text-sm hover:bg-neutral-100 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-neutral-800"
                >
                  <span className="shrink-0">
                    {node.icon?.type === 'emoji'
                      ? <span className="text-sm leading-none">{node.icon.value}</span>
                      : <FileText className="size-3.5 text-neutral-400" />}
                  </span>
                  <span className="truncate">{node.title || '제목 없음'}</span>
                  {here && <span className="ml-auto shrink-0 text-xs text-neutral-400">지금 위치</span>}
                </button>
              </li>
            )
          })}
          {shown.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-neutral-400">옮길 수 있는 곳이 없습니다</li>
          )}
        </ul>
      </div>
    </div>
  )
}
