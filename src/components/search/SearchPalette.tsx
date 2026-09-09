'use client'

/**
 * ⌘K / Ctrl+K 전역 검색.
 *
 * 서버 쪽은 이미 다 있었다 — lib/core/pages.ts 의 searchPages 가 pg_trgm 으로
 * 한국어 부분일치("회의" → "회의록")까지 처리하고 발췌도 만들어 준다.
 * 그동안 그걸 부르는 화면이 없어서 MCP 로만 쓸 수 있었다.
 *
 * 사이드바 버튼에서도 열려야 하는데, 그 하나 때문에 컨텍스트를 만들지 않고
 * 창 이벤트로 연다. 계약은 이 파일의 OPEN_SEARCH_EVENT 하나뿐이다.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { CornerDownLeft, FileText, Search } from 'lucide-react'
import { recentPages, searchPages } from '@/app/actions/pages'

export const OPEN_SEARCH_EVENT = 'unotion:open-search'

type Hit = { id: string; title: string; snippet?: string }

export function SearchPalette({ workspaceId }: { workspaceId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Hit[]>([])
  const [recent, setRecent] = useState<Hit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  /** 늦게 도착한 옛 응답이 새 결과를 덮어쓰지 않게 하는 표식 */
  const latestRequest = useRef(0)

  // ── 열기 (⌘K / Ctrl+K, 그리고 사이드바 버튼)

  useEffect(() => {
    const openPalette = () => {
      setOpen(true)
      setQuery('')
      setActive(0)
    }

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openPalette()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(OPEN_SEARCH_EVENT, openPalette)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(OPEN_SEARCH_EVENT, openPalette)
    }
  }, [])

  // 열릴 때 입력에 포커스
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 최근 문서
  useEffect(() => {
    if (!open) return
    let cancelled = false
    recentPages(workspaceId).then((res) => {
      if (!cancelled && res.ok) setRecent(res.data)
    })
    return () => { cancelled = true }
  }, [open, workspaceId])

  // ── 검색 (디바운스 150ms)

  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (!trimmed) return

    const id = ++latestRequest.current
    const timer = setTimeout(async () => {
      setLoading(true)
      const res = await searchPages(workspaceId, trimmed)
      // 그 사이 더 최근 요청이 나갔으면 이 응답은 버린다
      if (latestRequest.current !== id) return
      setLoading(false)
      if (res.ok) setResults(res.data)
    }, 150)

    return () => clearTimeout(timer)
  }, [open, query, workspaceId])

  if (!open) return null

  const q = query.trim()
  const shown = q ? results : recent
  const activeIdx = shown.length ? Math.min(active, shown.length - 1) : 0

  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(0)
  }

  const go = (id: string) => {
    close()
    router.push(`/p/${id}`)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (shown.length ? (i + 1) % shown.length : 0))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (shown.length ? (i - 1 + shown.length) % shown.length : 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = shown[activeIdx]
      if (hit) go(hit.id)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-label="검색 닫기"
        onClick={close}
        className="fixed inset-0 cursor-default bg-neutral-900/30 backdrop-blur-[1px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="검색"
        className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800">
          <Search className="size-4 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={onKeyDown}
            placeholder="페이지 검색…"
            aria-label="검색어"
            className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-neutral-400"
          />
          {loading && <span className="shrink-0 text-xs text-neutral-400">검색 중…</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {!q && <p className="px-3 py-2 text-xs font-medium text-neutral-400">최근 문서</p>}

          {shown.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-neutral-400">
              {q ? `"${q}" 와 일치하는 페이지가 없습니다.` : '문서가 없습니다.'}
            </p>
          ) : (
            <ul>
              {shown.map((hit, i) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(hit.id)}
                    aria-current={i === activeIdx}
                    className={
                      'flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left ' +
                      (i === activeIdx ? 'bg-neutral-100 dark:bg-neutral-800' : '')
                    }
                  >
                    <FileText className="mt-0.5 size-4 shrink-0 text-neutral-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <Highlight text={hit.title} query={q} />
                      </span>
                      {hit.snippet && (
                        <span className="mt-0.5 block truncate text-xs text-neutral-500">
                          <Highlight text={hit.snippet} query={q} />
                        </span>
                      )}
                    </span>
                    {i === activeIdx && (
                      <CornerDownLeft className="mt-0.5 size-3.5 shrink-0 text-neutral-400" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-3 border-t border-neutral-200 px-3 py-1.5 text-[11px] text-neutral-400 dark:border-neutral-800">
          <span>↑↓ 이동</span>
          <span>↵ 열기</span>
          <span>esc 닫기</span>
        </div>
      </div>
    </div>
  )
}

/** 검색어와 일치하는 부분을 강조. 대소문자는 구분하지 않는다. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>

  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0

  for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="bg-amber-200 text-inherit dark:bg-amber-700/60">
        {text.slice(at, at + query.length)}
      </mark>,
    )
    from = at + query.length
  }

  if (from === 0) return <>{text}</>
  parts.push(text.slice(from))
  return <>{parts}</>
}
