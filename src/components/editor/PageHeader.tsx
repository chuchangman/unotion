'use client'

import { useRef, useState } from 'react'
import { renamePage, setPageIcon } from '@/app/actions/pages'

const QUICK_EMOJI = ['📄', '📝', '📌', '✅', '🚀', '🐛', '💡', '📊', '🗓️', '🔧']

type Props = {
  pageId: string
  initialTitle: string
  icon: { type: 'emoji' | 'url'; value: string } | null
  canEdit: boolean
}

export function PageHeader({ pageId, initialTitle, icon, canEdit }: Props) {
  const [title, setTitle] = useState(initialTitle)
  const [current, setCurrent] = useState(icon)
  const [showPicker, setShowPicker] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 다른 페이지로 이동하면 부모가 `key={pageId}` 로 이 컴포넌트를 다시 마운트하므로
   * 서버 값을 다시 넘기는 이펙트가 필요 없다. 이펙트로 돌려놓으면 `icon` 이
   * 객체 prop 이라 매 렌더 실행되어, 자동저장 후 router.refresh() 가
   * **사용자가 치는 중인 제목을 서버 값으로 다시 덮는** 문제가 생긴다.
   */

  function onTitleChange(value: string) {
    setTitle(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const res = await renamePage(pageId, value)
      if (!res.ok) console.error('[header] 제목 저장 실패', res.message)
    }, 600)
  }

  async function pick(emoji: string | null) {
    setCurrent(emoji ? { type: 'emoji', value: emoji } : null)
    setShowPicker(false)
    const res = await setPageIcon(pageId, emoji)
    if (!res.ok) console.error('[header] 아이콘 저장 실패', res.message)
  }

  return (
    <header className="mb-4">
      <div className="relative mb-2">
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => setShowPicker((v) => !v)}
          className="rounded px-1 text-5xl leading-none hover:bg-neutral-100 disabled:hover:bg-transparent dark:hover:bg-neutral-800"
          aria-label="아이콘 선택"
        >
          {current?.type === 'emoji' ? current.value : '📄'}
        </button>

        {showPicker && (
          <div className="absolute left-0 top-full z-10 mt-1 flex flex-wrap gap-1 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            {QUICK_EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => pick(e)}
                className="rounded p-1 text-xl hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {e}
              </button>
            ))}
            <button
              type="button"
              onClick={() => pick(null)}
              className="rounded px-2 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              제거
            </button>
          </div>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        readOnly={!canEdit}
        placeholder="제목 없음"
        className="w-full bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
    </header>
  )
}
