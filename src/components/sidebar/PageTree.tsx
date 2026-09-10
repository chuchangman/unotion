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

  /**
   * 펼치기만 한다 (토글이 아니다).
   * 하위 문서를 만들 때 toggle 을 쓰면 **이미 펼쳐진 노드가 접혀버린다** —
   * 방금 만든 문서가 화면에서 사라지는 것처럼 보였다.
   */
  const expand = (id: string) =>
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))

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
          onExpand={expand}
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
  onExpand: (id: string) => void
  workspaceId: string
}

function Row({ node, depth, byParent, expanded, onToggle, onExpand, workspaceId }: RowProps) {
  const params = useParams<{ pageId?: string }>()
  const router = useRouter()
  const [pending, start] = useTransition()
  const [creating, setCreating] = useState(false)
  const isOpen = expanded.has(node.id)
  const isActive = params?.pageId === node.id
  const children = byParent.get(node.id) ?? []

  /**
   * 하위 문서 만들기.
   *
   * 새 문서의 id 를 알아야 이동할 수 있으니 액션 왕복 한 번은 못 줄인다.
   * 대신 **클릭 즉시** 부모를 펼치고 자리표시 행을 그려서, 기다리는 동안
   * 아무 반응이 없던 문제(행이 opacity-50 으로 멈춰 있기만 했다)를 없앤다.
   * 이동한 뒤 화면은 loading.tsx 골격이 즉시 받는다.
   */
  const addChild = () => {
    onExpand(node.id)
    setCreating(true)
    start(async () => {
      const res = await createPage({ workspaceId, parentId: node.id })
      if (res.ok) {
        router.push(`/p/${res.data.id}`)
      } else {
        setCreating(false)
        alert(res.message)
      }
    })
  }

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
          onExpand={onExpand}
          workspaceId={workspaceId}
        />
      ))}

      {/* 서버가 새 문서를 돌려주기 전까지 자리를 잡아 둔다 */}
      {creating && (
        <div
          className="flex items-center gap-1.5 rounded py-1 text-sm text-neutral-400"
          style={{ paddingLeft: (depth + 1) * 12 + 24 }}
        >
          <FileText className="size-3.5" />
          <span>만드는 중...</span>
        </div>
      )}
    </>
  )
}
