'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { renamePage, setPageIcon } from '@/app/actions/pages'
import { useWorkspaceSignal } from '@/components/live/WorkspaceLive'

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
  const [editing, setEditing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const router = useRouter()
  const emit = useWorkspaceSignal()
  /** 저장한 제목이 사이드바에 아직 안 반영됐는지 */
  const treeStale = useRef(false)

  /**
   * 서버 값이 바뀌면 따라간다 — 다른 사람이 제목·아이콘을 바꿔서 화면이 다시 그려졌을 때다
   * (실시간 신호가 router.refresh() 를 부른다, components/live/WorkspaceLive.tsx).
   *
   * ★ 치는 중이면 따라가지 않는다. 예전에 이펙트로 돌려놨을 때 `icon` 이 객체 prop 이라
   *   매 렌더 실행됐고, 새로고침이 **사용자가 치는 중인 제목을 서버 값으로 덮었다.**
   *   그래서 이펙트가 아니라 "렌더 중 이전 값과 비교" 로 하고, 값(문자열)으로 비교한다.
   * 다른 페이지로 옮기면 부모가 `key={pageId}` 로 다시 마운트하므로 여기와 무관하다.
   */
  const iconKey = icon ? `${icon.type}:${icon.value}` : ''
  const [seen, setSeen] = useState({ title: initialTitle, icon: iconKey })
  if (seen.title !== initialTitle || seen.icon !== iconKey) {
    setSeen({ title: initialTitle, icon: iconKey })
    if (!editing && seen.title !== initialTitle) setTitle(initialTitle)
    if (seen.icon !== iconKey) setCurrent(icon)
  }

  function onTitleChange(value: string) {
    setTitle(value)
    treeStale.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const res = await renamePage(pageId, value)
      if (!res.ok) console.error('[header] 제목 저장 실패', res.message)
    }, 600)
  }

  /**
   * 입력이 끝났을 때 한 번 확정 저장하고 사이드바를 맞춘다.
   *
   * renamePage 는 일부러 revalidate 를 하지 않는다 (그 액션의 주석 참고) —
   * 타이핑마다 앱 전체 캐시를 날리는 대신, 여기서 딱 한 번 새로고침한다.
   * 확정 저장(commit)일 때만 감사 로그에 남는다 — 타이핑 중 저장은 남기지 않는다.
   */
  async function flushTitle() {
    setEditing(false)
    if (!treeStale.current) return
    treeStale.current = false
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const res = await renamePage(pageId, title, true)
    if (!res.ok) {
      console.error('[header] 제목 저장 실패', res.message)
      return
    }
    emit({ kind: 'tree' }) // 다른 사람의 사이드바와 이 문서 머리도
    router.refresh()
  }

  async function pick(emoji: string | null) {
    setCurrent(emoji ? { type: 'emoji', value: emoji } : null)
    setShowPicker(false)
    const res = await setPageIcon(pageId, emoji)
    if (!res.ok) console.error('[header] 아이콘 저장 실패', res.message)
    else emit({ kind: 'tree' })
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
        onFocus={() => setEditing(true)}
        onBlur={() => { void flushTitle() }}
        readOnly={!canEdit}
        placeholder="제목 없음"
        className="w-full bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
    </header>
  )
}
