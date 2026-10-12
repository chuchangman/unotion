'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { KeyRound, Menu, Plus, Search, Trash2, Users } from 'lucide-react'
import { createPage } from '@/app/actions/pages'
import { OPEN_SEARCH_EVENT } from '@/components/search/SearchPalette'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { PageTree } from './PageTree'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { useWorkspaceSignal } from '@/components/live/WorkspaceLive'
import type { TreeNode } from '@/lib/core/pages'
import type { MyWorkspace } from '@/lib/core/workspaces'
import type { WorkspaceRole } from '@/lib/core/permissions'

type Props = {
  workspace: { id: string; name: string; role: WorkspaceRole }
  /** 내가 속한 룸 전부 — 상단 전환기 드롭다운용 */
  workspaces: MyWorkspace[]
  nodes: TreeNode[]
  user: { name: string }
  unread: number
}

export function Sidebar({ workspace, workspaces, nodes, user, unread }: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()

  const emit = useWorkspaceSignal()

  /**
   * 휴대폰에서는 사이드바가 서랍이다 (md 미만). 폭 256px 를 늘 깔아 두면
   * 본문이 화면의 1/3 밖에 안 남는다.
   *
   * 열 때의 경로를 기억해 두고 "지금 경로와 같을 때만 열림" 으로 본다.
   * 그러면 문서를 눌러 이동하는 순간 effect 없이 저절로 닫힌다.
   */
  const pathname = usePathname()
  const [openedAt, setOpenedAt] = useState<string | null>(null)
  const open = openedAt === pathname
  const close = () => setOpenedAt(null)

  const addRootPage = () =>
    start(async () => {
      const res = await createPage({ workspaceId: workspace.id, parentId: null })
      if (!res.ok) {
        alert(res.message)
        return
      }
      emit({ kind: 'tree' }) // 다른 사람의 사이드바도
      router.push(`/p/${res.data.id}`)
    })

  return (
    <>
    <button
      type="button"
      onClick={() => setOpenedAt(pathname)}
      aria-label="메뉴 열기"
      className="fixed left-2 top-2 z-20 rounded-md bg-white/80 p-2 text-neutral-600 backdrop-blur hover:bg-neutral-100 md:hidden dark:bg-neutral-950/80 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      <Menu className="size-5" />
    </button>

    {open && (
      <div
        aria-hidden
        onClick={close}
        className="fixed inset-0 z-30 bg-black/30 md:hidden"
      />
    )}

    <aside
      className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 transition-transform md:static md:translate-x-0 dark:border-neutral-800 dark:bg-neutral-950 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <WorkspaceSwitcher
        workspace={workspace}
        workspaces={workspaces}
        userName={user.name}
      />

      {/*
        단축키만 있으면 아무도 모른다. 버튼을 두되 단축키를 함께 보여줘서
        다음부터는 ⌘K 를 쓰게 만든다.
      */}
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <Search className="size-4" />
          검색
          <kbd className="ml-auto rounded border border-neutral-300 px-1 text-[10px] text-neutral-400 dark:border-neutral-700">
            ⌘K
          </kbd>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <PageTree workspaceId={workspace.id} nodes={nodes} canMoveToRoot={workspace.role !== 'guest'} />
      </nav>

      <div className="border-t border-neutral-200 p-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={addRootPage}
          disabled={pending}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <Plus className="size-4" />
          새 페이지
        </button>

        <Link
          href="/settings/members"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <Users className="size-4" />
          팀 멤버
        </Link>

        <NotificationBell initialUnread={unread} />

        <Link
          href="/trash"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <Trash2 className="size-4" />
          휴지통
        </Link>

        <Link
          href="/settings/tokens"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <KeyRound className="size-4" />
          AI 연결 (MCP)
        </Link>
      </div>
    </aside>
    </>
  )
}
