'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { ChevronRight, FileText, Plus, Trash2 } from 'lucide-react'
import { createPage, trashPage } from '@/app/actions/pages'
import type { TreeNode } from '@/lib/core/pages'

type Props = { workspaceId: string; nodes: TreeNode[] }

/** flat 목록을 parentId 기준으로 묶는다. sortKey 순서는 서버가 이미 보장한다. */
function groupByParent(nodes: TreeNode[]) {
  const map = new Map<string | null, TreeNode[]>()
  for (const n of nodes) {
    const key = n.parentId
    const list = map.get(key)
    if (list) list.push(n)
    else map.set(key, [n])
  }
  return map
}

export function PageTree({ workspaceId, nodes }: Props) {
  const byParent = useMemo(() => groupByParent(nodes), [nodes])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-px">
      {(byParent.get(null) ?? []).map((node) => (
        <Row
          key={node.id}
          node={node}
          depth={0}
          byParent={byParent}
          expanded={expanded}
          onToggle={toggle}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  )
}

type RowProps = {
  node: TreeNode
  depth: number
  byParent: Map<string | null, TreeNode[]>
  expanded: Set<string>
  onToggle: (id: string) => void
  workspaceId: string
}

function Row({ node, depth, byParent, expanded, onToggle, workspaceId }: RowProps) {
  const params = useParams<{ pageId?: string }>()
  const router = useRouter()
  const [pending, start] = useTransition()
  const isOpen = expanded.has(node.id)
  const isActive = params?.pageId === node.id
  const children = byParent.get(node.id) ?? []

  const addChild = () =>
    start(async () => {
      const res = await createPage({ workspaceId, parentId: node.id })
      if (res.ok) {
        onToggle(node.id)
        router.push(`/p/${res.data.id}`)
      } else {
        alert(res.message)
      }
    })

  const remove = () =>
    start(async () => {
      if (!confirm(`"${node.title || '제목 없음'}" 을 휴지통으로 보낼까요? 하위 페이지도 함께 이동합니다.`)) return
      const res = await trashPage(node.id)
      if (!res.ok) alert(res.message)
      else if (isActive) router.push('/')
    })

  return (
    <>
      <div
        className={`group flex items-center gap-1 rounded pr-1 text-sm ${
          isActive ? 'bg-neutral-200/70 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
        } ${pending ? 'opacity-50' : ''}`}
        style={{ paddingLeft: depth * 12 }}
      >
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          aria-label={isOpen ? '접기' : '펼치기'}
          className={`flex size-5 shrink-0 items-center justify-center rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 ${
            node.hasChildren ? '' : 'invisible'
          }`}
        >
          <ChevronRight className={`size-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        </button>

        <Link href={`/p/${node.id}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
          <span className="shrink-0">
            {node.icon?.type === 'emoji'
              ? <span className="text-sm leading-none">{node.icon.value}</span>
              : <FileText className="size-3.5 text-neutral-400" />}
          </span>
          <span className="truncate">{node.title || '제목 없음'}</span>
        </Link>

        <button
          type="button"
          onClick={addChild}
          aria-label="하위 페이지 추가"
          className="hidden size-5 shrink-0 items-center justify-center rounded hover:bg-neutral-200 group-hover:flex dark:hover:bg-neutral-700"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={remove}
          aria-label="휴지통으로"
          className="hidden size-5 shrink-0 items-center justify-center rounded hover:bg-neutral-200 group-hover:flex dark:hover:bg-neutral-700"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {isOpen && children.map((child) => (
        <Row
          key={child.id}
          node={child}
          depth={depth + 1}
          byParent={byParent}
          expanded={expanded}
          onToggle={onToggle}
          workspaceId={workspaceId}
        />
      ))}
    </>
  )
}
