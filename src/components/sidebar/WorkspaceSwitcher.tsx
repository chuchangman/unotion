'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Pencil, Plus } from 'lucide-react'
import {
  createProjectRoom,
  renameProjectRoom,
  switchProjectRoom,
} from '@/app/actions/workspaces'
import type { MyWorkspace } from '@/lib/core/workspaces'
import type { WorkspaceRole } from '@/lib/core/permissions'

type Props = {
  /** 지금 보고 있는 룸 */
  workspace: { id: string; name: string; role: WorkspaceRole }
  /** 내가 속한 룸 전부 */
  workspaces: MyWorkspace[]
  userName: string
}

/**
 * 사이드바 맨 위의 프로젝트 룸 전환기.
 *
 *   - 이름을 누르면 드롭다운: 내 룸 목록 + 새 룸 만들기
 *   - 호버하면 오른쪽에 연필: 이름 바꾸기 (admin 이상만 보인다)
 *
 * 권한은 서버에서 다시 검사한다 (renameWorkspace 의 assertWorkspaceAdmin).
 * 연필을 숨기는 건 편의일 뿐 방어선이 아니다.
 */
export function WorkspaceSwitcher({ workspace, workspaces, userName }: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  /** idle | rename(제목 자리 입력) | create(드롭다운 안 입력) */
  const [mode, setMode] = useState<'idle' | 'rename' | 'create'>('idle')
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  /** Esc 로 빠져나갈 때 뒤따르는 blur 가 저장하지 않도록 하는 표시 */
  const cancelled = useRef(false)

  const canRename = workspace.role === 'owner' || workspace.role === 'admin'

  // 바깥을 누르거나 Esc 를 누르면 닫는다
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setMode('idle')
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setMode('idle') }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const switchTo = (id: string) => {
    if (id === workspace.id) { setOpen(false); return }
    start(async () => {
      const res = await switchProjectRoom(id)
      if (!res.ok) { alert(res.message); return }
      setOpen(false)
      /**
       * 보던 문서는 이전 룸 소속이라 그 자리에 남으면 사이드바와 본문이 어긋난다.
       * 액션이 돌려준 새 룸의 첫 문서로 옮긴다 (빈 룸이면 "/" 가 안내를 띄운다).
       */
      router.push(res.data.pageId ? `/p/${res.data.pageId}` : '/')
    })
  }

  const submitCreate = () => {
    start(async () => {
      const res = await createProjectRoom(draft)
      if (!res.ok) { alert(res.message); return }
      setOpen(false)
      setMode('idle')
      setDraft('')
      router.push(`/p/${res.data.pageId}`)
    })
  }

  const startRename = () => {
    cancelled.current = false
    setDraft(workspace.name)
    setMode('rename')
    setOpen(false)
  }

  const submitRename = () => {
    if (cancelled.current) { setMode('idle'); return }
    const name = draft.trim()
    if (!name || name === workspace.name) { setMode('idle'); return }
    start(async () => {
      const res = await renameProjectRoom(workspace.id, name)
      setMode('idle')
      // 서버가 거절하면(권한 없음 등) 이유를 보여준다 — 화면의 이름은 되돌아간다
      if (!res.ok) alert(res.message)
    })
  }

  return (
    <div ref={rootRef} className="relative px-3 py-3">
      {mode === 'rename' ? (
        <input
          autoFocus
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
          }}
          aria-label="프로젝트 룸 이름"
          className="w-full rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-sm font-semibold outline-none focus:border-neutral-900 dark:border-neutral-600 dark:bg-neutral-900 dark:focus:border-neutral-100"
        />
      ) : (
        <div className="group flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="menu"
            className="-mx-1 flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
          >
            <span className="truncate text-sm font-semibold">{workspace.name}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-neutral-400" />
          </button>

          {canRename && (
            <button
              type="button"
              onClick={startRename}
              aria-label="프로젝트 룸 이름 수정"
              title="이름 수정"
              className="hidden size-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 group-hover:flex dark:hover:bg-neutral-700"
            >
              <Pencil className="size-3.5" />
            </button>
          )}
        </div>
      )}

      <p className="truncate text-xs text-neutral-500">{userName}</p>

      {open && (
        <div
          role="menu"
          className="absolute inset-x-2 top-full z-30 mt-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-neutral-400">
            프로젝트 룸
          </p>

          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitem"
              onClick={() => switchTo(w.id)}
              disabled={pending}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
            >
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="shrink-0 text-xs text-neutral-400">{w.memberCount}명</span>
              {w.id === workspace.id && <Check className="size-3.5 shrink-0" />}
            </button>
          ))}

          <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />

          {mode === 'create' ? (
            <div className="flex items-center gap-1 p-1">
              <input
                autoFocus
                value={draft}
                maxLength={60}
                placeholder="룸 이름"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitCreate()
                  if (e.key === 'Escape') { setMode('idle'); setDraft('') }
                }}
                aria-label="새 프로젝트 룸 이름"
                className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 py-1 text-sm outline-none focus:border-neutral-900 dark:border-neutral-600 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
              <button
                type="button"
                onClick={submitCreate}
                disabled={pending}
                className="shrink-0 rounded bg-neutral-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
              >
                만들기
              </button>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setDraft(''); setMode('create') }}
              disabled={pending}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              <Plus className="size-4" />
              새 프로젝트 룸
            </button>
          )}
        </div>
      )}
    </div>
  )
}
