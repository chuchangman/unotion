'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { renamePage, setPageIcon } from '@/app/actions/pages'

const QUICK_EMOJI = ['📄', '📝', '📌', '✅', '🚀', '🐛', '💡', '📊', '🗓️', '🔧']

type Props = {
  pageId: string
  initialTitle: string
  icon: { type: 'emoji' | 'url'; value: string } | null
  canEdit: boolean
  /**
   * 이 제목을 브라우저 탭에 띄울지.
   *
   * ★ 기본은 꺼 둔다. 이 컴포넌트는 본문 화면과 **우측 미리보기 패널**에서
   *   같이 쓰이는데, 미리보기를 열 때마다 탭 이름이 바뀌면 지금 보고 있는
   *   문서가 무엇인지 알 수 없게 된다. 켜는 쪽은 본문 화면 하나뿐이다.
   */
  syncTabTitle?: boolean
}

export function PageHeader({
  pageId,
  initialTitle,
  icon,
  canEdit,
  syncTabTitle = false,
}: Props) {
  const [title, setTitle] = useState(initialTitle)
  const [current, setCurrent] = useState(icon)
  const [showPicker, setShowPicker] = useState(false)
  /**
   * 문서 제목을 브라우저 탭에 띄운다.
   *
   * 서버에서 generateMetadata 로 해도 되지만 그러면 문서를 그릴 때마다 제목을
   * 읽는 DB 왕복이 하나 더 붙는다. 이 앱에서 제일 신경 쓴 게 그 왕복 수다
   * (README 성능 메모). 게다가 제목을 고치는 **중에도** 탭이 따라와야 하는데
   * 서버 메타데이터는 그걸 못 한다 — 이 상태값은 타이핑하는 즉시 바뀐다.
   *
   * 되돌리기(cleanup)는 하지 않는다. 다음 문서로 가면 그쪽 PageHeader 가
   * 곧바로 덮어쓰고, 문서 밖 화면은 각자 자기 제목을 쓴다.
   */
  useEffect(() => {
    if (!syncTabTitle) return
    document.title = `${title.trim() || '제목 없음'} · 우노션`
  }, [syncTabTitle, title])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const router = useRouter()
  /** 저장한 제목이 사이드바에 아직 안 반영됐는지 */
  const treeStale = useRef(false)

  /**
   * 다른 페이지로 이동하면 부모가 `key={pageId}` 로 이 컴포넌트를 다시 마운트하므로
   * 서버 값을 다시 넘기는 이펙트가 필요 없다. 이펙트로 돌려놓으면 `icon` 이
   * 객체 prop 이라 매 렌더 실행되어, 자동저장 후 router.refresh() 가
   * **사용자가 치는 중인 제목을 서버 값으로 다시 덮는** 문제가 생긴다.
   */

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
   * 입력이 끝났을 때 한 번만 사이드바를 맞춘다.
   *
   * renamePage 는 일부러 revalidate 를 하지 않는다 (그 액션의 주석 참고) —
   * 타이핑마다 앱 전체 캐시를 날리는 대신, 여기서 딱 한 번 새로고침한다.
   * 아직 디바운스가 남아 있으면 먼저 저장을 끝낸 뒤 부른다.
   */
  async function flushTitle() {
    if (!treeStale.current) return
    treeStale.current = false
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
      const res = await renamePage(pageId, title)
      if (!res.ok) {
        console.error('[header] 제목 저장 실패', res.message)
        return
      }
    }
    router.refresh()
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
        onBlur={() => { void flushTitle() }}
        readOnly={!canEdit}
        placeholder="제목 없음"
        className="w-full bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
      />
    </header>
  )
}
