'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createReactBlockSpec } from '@blocknote/react'
import { FileText, Plus } from 'lucide-react'
import {
  PAGE_BOARD_TYPE,
  pageBoardPropSchema,
  parseColumns,
  serializeColumns,
  type BoardColumn,
} from '@/lib/page-board'
import { createLinkedChildPage } from '@/app/actions/pages'
import { getJson } from '@/lib/api/client'
import { qk } from '@/lib/query-keys'
import { useWorkspaceSignal } from '@/components/live/WorkspaceLive'

type Child = { id: string; title: string; icon: { type: 'emoji' | 'url'; value: string } | null }

function Icon({ icon }: { icon: Child['icon'] }) {
  if (icon?.type === 'emoji') {
    return <span className="w-4 shrink-0 text-center text-sm leading-none">{icon.value}</span>
  }
  return <FileText className="size-4 shrink-0 text-neutral-400" />
}

/** 보드 한 칸: 제목 + 하위 페이지 목록 + 새 페이지 버튼 */
function BoardColumnView({
  column,
  childPages,
  workspaceId,
  editable,
  onOpen,
  onChanged,
}: {
  column: BoardColumn
  /** null 이면 아직 로딩 중 */
  childPages: Child[] | null
  workspaceId: string
  editable: boolean
  onOpen: (pageId: string) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const emit = useWorkspaceSignal()

  const addPage = async () => {
    if (!workspaceId) return
    setBusy(true)
    const res = await createLinkedChildPage({
      workspaceId,
      parentId: column.pageId,
      title: '제목 없음',
    })
    setBusy(false)
    if (res.ok) {
      emit({ kind: 'tree' })
      onChanged()
      onOpen(res.data.id)
    } else {
      console.error('[board] 페이지 생성 실패', res.message)
    }
  }

  return (
    <div className="min-w-0 px-1">
      <button
        type="button"
        onClick={() => onOpen(column.pageId)}
        className="mb-2 flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-lg font-semibold hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <span className="truncate">{column.title || '제목 없음'}</span>
      </button>

      <div className="space-y-px">
        {childPages === null && (
          <>
            <div className="h-7 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
            <div className="h-7 w-4/5 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          </>
        )}

        {childPages?.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onOpen(c.id)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Icon icon={c.icon} />
            <span className="truncate">{c.title || '제목 없음'}</span>
          </button>
        ))}

        {childPages?.length === 0 && (
          <p className="px-1.5 py-1 text-sm text-neutral-400">아직 페이지가 없습니다</p>
        )}

        {editable && (
          <button
            type="button"
            onClick={addPage}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            <Plus className="size-4 shrink-0" />
            새 페이지
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 페이지 보드 블록 — 칸마다 "어떤 페이지의 하위 페이지 목록" 을 나란히 보여 준다.
 *
 * 본문을 좌우로 나누는 다단(@blocknote/xl-multi-column)과는 다른 것이다. 다단은 **블록**을
 * 배치하고, 이건 하위 페이지 **목록**을 보여 준다. 보드가 먼저 생겼고, 그때는 다단 패키지의
 * 라이선스(GPL-3.0) 때문에 자체 레이아웃과 리사이즈를 짰다. 지금은 다단도 쓰지만
 * (LICENSE 참고) 보드는 칸 폭 조절까지 여기서 끝나므로 그대로 둔다.
 */
export const PageBoardBlock = createReactBlockSpec(
  {
    type: PAGE_BOARD_TYPE,
    propSchema: pageBoardPropSchema,
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      /* eslint-disable react-hooks/rules-of-hooks */
      const router = useRouter()
      const rowRef = useRef<HTMLDivElement>(null)
      const [dragging, setDragging] = useState<number | null>(null)
      const [workspaceId, setWorkspaceId] = useState('')

      // workspaceId 는 에디터 컨테이너의 data 속성에서 읽는다
      useEffect(() => {
        const el = rowRef.current?.closest<HTMLElement>('[data-workspace-id]')
        if (el?.dataset.workspaceId) setWorkspaceId(el.dataset.workspaceId)
      }, [])

      const columns = parseColumns(block.props.columns)
      const editable = editor.isEditable

      /**
       * 모든 칸의 목록을 한 번에 가져온다.
       * 칸마다 부르면 칸 수만큼 왕복이 생긴다.
       * key 는 pageId 목록이라 폭을 드래그해도 다시 조회하지 않는다.
       */
      const parentKey = columns.map((c) => c.pageId).join(',')
      const queryClient = useQueryClient()
      const children = useQuery({
        queryKey: qk.children(parentKey),
        queryFn: () =>
          getJson<{ lists: Record<string, Child[]> }>(
            `/api/pages/children?parents=${encodeURIComponent(parentKey)}`,
          ).then((r) => r.lists),
        enabled: parentKey.length > 0,
      })
      // 실패하면 칸마다 "아직 페이지가 없습니다" 로 둔다 (예전과 같다)
      const lists = children.data ?? (children.isError ? {} : null)

      const reload = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: qk.children(parentKey) })
      }, [queryClient, parentKey])

      const open = (pageId: string) => {
        const qs = new URLSearchParams(window.location.search)
        qs.set('peek', pageId)
        router.push(`${window.location.pathname}?${qs}`, { scroll: false })
      }

      /** 경계를 끌면 양옆 칸의 비율만 바꾼다 (전체 합은 유지) */
      useEffect(() => {
        if (dragging === null) return

        const onMove = (e: MouseEvent) => {
          const row = rowRef.current
          if (!row) return
          const rect = row.getBoundingClientRect()
          const cols = parseColumns(block.props.columns)
          if (dragging + 1 >= cols.length) return

          const left = cols.slice(0, dragging).reduce((a, c) => a + c.width, 0)
          const pair = cols[dragging].width + cols[dragging + 1].width
          const pct = ((e.clientX - rect.left) / rect.width) * 100
          const leftW = Math.min(Math.max(pct - left, 15), pair - 15) // 최소 15%

          cols[dragging] = { ...cols[dragging], width: leftW }
          cols[dragging + 1] = { ...cols[dragging + 1], width: pair - leftW }
          editor.updateBlock(block, {
            type: PAGE_BOARD_TYPE,
            props: { columns: serializeColumns(cols) },
          })
        }
        const onUp = () => setDragging(null)

        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [dragging, block, editor])
      /* eslint-enable react-hooks/rules-of-hooks */

      if (columns.length === 0) {
        return (
          <div className="my-2 rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-400 dark:border-neutral-700">
            빈 페이지 보드입니다. 슬래시 메뉴에서 다시 만들어 주세요.
          </div>
        )
      }

      return (
        <div ref={rowRef} className="my-3 flex w-full items-stretch">
          {columns.map((col, i) => (
            <div key={col.pageId} className="flex min-w-0" style={{ width: `${col.width}%` }}>
              <div className="min-w-0 flex-1">
                <BoardColumnView
                  column={col}
                  childPages={lists ? (lists[col.pageId] ?? []) : null}
                  workspaceId={workspaceId}
                  editable={editable}
                  onOpen={open}
                  onChanged={reload}
                />
              </div>

              {i < columns.length - 1 && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="칸 너비 조절"
                  onMouseDown={(e) => {
                    if (!editable) return
                    e.preventDefault()
                    setDragging(i)
                  }}
                  className={`group relative w-3 shrink-0 ${editable ? 'cursor-col-resize' : ''}`}
                >
                  <span
                    className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
                      dragging === i
                        ? 'bg-blue-500'
                        : 'bg-neutral-200 group-hover:bg-blue-400 dark:bg-neutral-800'
                    }`}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )
    },
  },
)
