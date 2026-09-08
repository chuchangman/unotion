'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { KeyRound, Plus } from 'lucide-react'
import { createPage } from '@/app/actions/pages'
import { PageTree } from './PageTree'
import type { TreeNode } from '@/lib/core/pages'

type Props = {
  workspace: { id: string; name: string }
  nodes: TreeNode[]
  user: { name: string }
}

export function Sidebar({ workspace, nodes, user }: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()

  const addRootPage = () =>
    start(async () => {
      const res = await createPage({ workspaceId: workspace.id, parentId: null })
      if (res.ok) router.push(`/p/${res.data.id}`)
      else alert(res.message)
    })

  return (
    <aside className="flex h-dvh w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="px-3 py-3">
        <p className="truncate text-sm font-semibold">{workspace.name}</p>
        <p className="truncate text-xs text-neutral-500">{user.name}</p>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <PageTree workspaceId={workspace.id} nodes={nodes} />
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
          href="/settings/tokens"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <KeyRound className="size-4" />
          Claude 연결
        </Link>
      </div>
    </aside>
  )
}
