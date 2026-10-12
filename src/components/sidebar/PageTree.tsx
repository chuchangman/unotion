'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  useCallback, useEffect, useMemo, useState, useSyncExternalStore, useTransition, type DragEvent,
} from 'react'
import { ChevronRight, FileText, FolderInput, Plus, Trash2 } from 'lucide-react'
import { createPage, movePage, trashPage } from '@/app/actions/pages'
import type { TreeNode } from '@/lib/core/pages'
import {
  ancestorIds, dropTarget, groupByParent, type ByParent, type DropZone, type MoveTarget,
} from '@/lib/page-tree'
import { MovePageDialog } from './MovePageDialog'
import { useWorkspaceSignal } from '@/components/live/WorkspaceLive'

type Props = {
  workspaceId: string
  nodes: TreeNode[]
  /** 게스트면 false — 최상위로는 못 옮긴다 (서버도 막는다, lib/core/pages.ts 의 movePage) */
  canMoveToRoot: boolean
}

// ─────────────────────────────────── 펼침 상태
//
// 예전에는 useState 라 새로고침하면 전부 접혔다. 룸마다 localStorage 에 기억한다.
// 읽기는 useSyncExternalStore — 서버 렌더에는 "다 접힘" 을 주고 브라우저에서 저장된 값으로
// 바꾼다(하이드레이션 불일치 없이). 저장소를 못 쓰는 환경(시크릿 창)은 메모리로만 동작한다.

const EMPTY = '[]'
const memory = new Map<string, string>()
const listeners = new Set<() => void>()
const storageKey = (workspaceId: string) => `unotion:tree-open:${workspaceId}`

function readOpen(workspaceId: string): string {
  const cached = memory.get(workspaceId)
  if (cached !== undefined) return cached
  let raw = EMPTY
  try {
    raw = localStorage.getItem(storageKey(workspaceId)) ?? EMPTY
  } catch {
    // 저장소를 못 쓴다 — 이번 화면에서만 기억한다
  }
  memory.set(workspaceId, raw)
  return raw
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeOpen(workspaceId: string, ids: Set<string>) {
  const raw = JSON.stringify([...ids])
  memory.set(workspaceId, raw)
  try {
    localStorage.setItem(storageKey(workspaceId), raw)
  } catch {
    // 저장소를 못 쓴다 — 메모리에는 남았다
  }
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void) {
  // 다른 탭에서 펼친 것도 따라간다
  const onStorage = () => {
    memory.clear()
    onChange()
  }
  listeners.add(onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

// ───────────────────────────────────

export function PageTree({ workspaceId, nodes, canMoveToRoot }: Props) {
  const params = useParams<{ pageId?: string }>()
  const activeId = params?.pageId ?? null
  const byParent = useMemo(() => groupByParent(nodes), [nodes])

  const raw = useSyncExternalStore(subscribe, () => readOpen(workspaceId), () => EMPTY)
  const expanded = useMemo(() => new Set(parseIds(raw)), [raw])

  const setOpen = useCallback((id: string, open: boolean) => {
    const next = new Set(parseIds(readOpen(workspaceId)))
    if (open) next.add(id)
    else next.delete(id)
    writeOpen(workspaceId, next)
  }, [workspaceId])

  /**
   * 링크나 검색으로 깊은 문서를 열면 조상을 펼쳐서 사이드바에서도 보이게 한다.
   * 펼친 건 기억되므로, 사용자가 나중에 접으면 그대로 접힌다.
   */
  useEffect(() => {
    if (!activeId) return
    const current = new Set(parseIds(readOpen(workspaceId)))
    const up = ancestorIds(nodes, activeId).filter((id) => !current.has(id))
    if (up.length === 0) return
    up.forEach((id) => current.add(id))
    writeOpen(workspaceId, current)
  }, [activeId, nodes, workspaceId])

  // ── 옮기기 (끌어서 놓기 + "이동…")
  const [dragging, setDragging] = useState<string | null>(null)
  const [hint, setHint] = useState<{ id: string; zone: DropZone } | null>(null)
  const [moving, setMoving] = useState<TreeNode | null>(null)
  const [, start] = useTransition()
  const emit = useWorkspaceSignal()

  const moveTo = (pageId: string, target: MoveTarget) =>
    start(async () => {
      const res = await movePage(pageId, target)
      if (!res.ok) {
        alert(res.message)
        return
      }
      // 옮겨 간 곳을 펼쳐서 방금 옮긴 페이지가 보이게 한다. 트리는 액션의 revalidate 가 다시 그린다
      if (target.parentId) setOpen(target.parentId, true)
      emit({ kind: 'tree' }) // 다른 사람의 사이드바도
    })

  /** 놓을 수 있는 자리면 movePage 인자, 아니면 null */
  const targetFor = (draggedId: string, node: TreeNode, zone: DropZone) => {
    const target = dropTarget(byParent, draggedId, node, zone)
    return target && (canMoveToRoot || target.parentId !== null) ? target : null
  }

  const drag = {
    dragging,
    hint,
    start: (id: string) => setDragging(id),
    over: (node: TreeNode, zone: DropZone): boolean => {
      if (!dragging || !targetFor(dragging, node, zone)) {
        if (hint?.id === node.id) setHint(null)
        return false
      }
      if (hint?.id !== node.id || hint.zone !== zone) setHint({ id: node.id, zone })
      return true
    },
    drop: (node: TreeNode, zone: DropZone) => {
      const target = dragging ? targetFor(dragging, node, zone) : null
      if (dragging && target) moveTo(dragging, target)
      setDragging(null)
      setHint(null)
    },
    end: () => {
      setDragging(null)
      setHint(null)
    },
  }

  return (
    <div className="space-y-px">
      {(byParent.get(null) ?? []).map((node) => (
        <Row
          key={node.id}
          node={node}
          depth={0}
          byParent={byParent}
          expanded={expanded}
          activeId={activeId}
          onToggle={(id) => setOpen(id, !expanded.has(id))}
          onExpand={(id) => setOpen(id, true)}
          onMove={setMoving}
          drag={drag}
          workspaceId={workspaceId}
        />
      ))}

      {moving && (
        <MovePageDialog
          page={moving}
          byParent={byParent}
          allowRoot={canMoveToRoot}
          onClose={() => setMoving(null)}
          onPick={(parentId) => {
            setMoving(null)
            // 새 부모의 맨 끝으로 간다 (서버가 정렬 키를 정한다)
            moveTo(moving.id, { parentId, afterId: null, beforeId: null })
          }}
        />
      )}
    </div>
  )
}

type Drag = {
  dragging: string | null
  hint: { id: string; zone: DropZone } | null
  start: (id: string) => void
  /** 놓을 수 있는 자리면 true — 그때만 drop 을 허용한다 */
  over: (node: TreeNode, zone: DropZone) => boolean
  drop: (node: TreeNode, zone: DropZone) => void
  end: () => void
}

type RowProps = {
  node: TreeNode
  depth: number
  byParent: ByParent
  expanded: Set<string>
  activeId: string | null
  onToggle: (id: string) => void
  onExpand: (id: string) => void
  onMove: (node: TreeNode) => void
  drag: Drag
  workspaceId: string
}

/** 행의 위 1/4 은 "앞", 아래 1/4 은 "뒤", 가운데는 "안으로" */
function zoneOf(e: DragEvent<HTMLElement>): DropZone {
  const rect = e.currentTarget.getBoundingClientRect()
  const y = (e.clientY - rect.top) / rect.height
  return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside'
}

function Row(props: RowProps) {
  const { node, depth, byParent, expanded, activeId, onToggle, onExpand, onMove, drag, workspaceId } = props
  const router = useRouter()
  const [pending, start] = useTransition()
  const [creating, setCreating] = useState(false)
  const emit = useWorkspaceSignal()
  const isOpen = expanded.has(node.id)
  const isActive = activeId === node.id
  const children = byParent.get(node.id) ?? []
  const hint = drag.hint?.id === node.id ? drag.hint.zone : null

  /**
   * 하위 문서 만들기.
   *
   * 새 문서의 id 를 알아야 이동할 수 있으니 액션 왕복 한 번은 못 줄인다.
   * 대신 **클릭 즉시** 부모를 펼치고 자리표시 행을 그려서, 기다리는 동안
   * 아무 반응이 없던 문제(행이 opacity-50 으로 멈춰 있기만 했다)를 없앤다.
   * 이동한 뒤 화면은 loading.tsx 골격이 즉시 받는다.
   *
   * 펼치기만 한다 (토글이 아니다) — toggle 을 쓰면 **이미 펼쳐진 노드가 접혀서**
   * 방금 만든 문서가 화면에서 사라지는 것처럼 보였다.
   */
  const addChild = () => {
    onExpand(node.id)
    setCreating(true)
    start(async () => {
      const res = await createPage({ workspaceId, parentId: node.id })
      if (res.ok) {
        emit({ kind: 'tree' })
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
      if (!res.ok) {
        alert(res.message)
        return
      }
      emit({ kind: 'tree' })
      if (isActive) router.push('/')
    })

  return (
    <>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', node.id) // 파이어폭스는 데이터가 없으면 끌기를 시작하지 않는다
          e.dataTransfer.effectAllowed = 'move'
          drag.start(node.id)
        }}
        onDragOver={(e) => {
          if (!drag.over(node, zoneOf(e))) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(e) => {
          e.preventDefault()
          drag.drop(node, zoneOf(e))
        }}
        onDragEnd={drag.end}
        className={`group flex items-center gap-1 rounded pr-1 text-sm ${
          isActive ? 'bg-neutral-200/70 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
        } ${pending || drag.dragging === node.id ? 'opacity-50' : ''} ${
          hint === 'inside' ? 'bg-blue-100 dark:bg-blue-950'
          : hint === 'before' ? 'shadow-[inset_0_2px_0_0_#3b82f6]'
          : hint === 'after' ? 'shadow-[inset_0_-2px_0_0_#3b82f6]'
          : ''
        }`}
        style={{ paddingLeft: depth * 12 }}
      >
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          aria-label={isOpen ? '접기' : '펼치기'}
          aria-expanded={node.hasChildren ? isOpen : undefined}
          className={`flex size-5 shrink-0 items-center justify-center rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 ${
            node.hasChildren ? '' : 'invisible'
          }`}
        >
          <ChevronRight className={`size-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        </button>

        {/* 링크 자체를 끌면 브라우저가 주소를 끈다 — 행이 끌리게 링크는 끌기를 끈다 */}
        <Link href={`/p/${node.id}`} draggable={false} className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
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
          className="hidden size-5 shrink-0 items-center justify-center rounded hover:bg-neutral-200 group-hover:flex group-focus-within:flex dark:hover:bg-neutral-700"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(node)}
          aria-label="다른 곳으로 옮기기"
          title="옮기기"
          className="hidden size-5 shrink-0 items-center justify-center rounded hover:bg-neutral-200 group-hover:flex group-focus-within:flex dark:hover:bg-neutral-700"
        >
          <FolderInput className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={remove}
          aria-label="휴지통으로"
          className="hidden size-5 shrink-0 items-center justify-center rounded hover:bg-neutral-200 group-hover:flex group-focus-within:flex dark:hover:bg-neutral-700"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {isOpen && children.map((child) => (
        <Row key={child.id} {...props} node={child} depth={depth + 1} />
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
