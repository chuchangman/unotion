'use client'

/**
 * 보드 뷰. select / status 속성 하나를 기준으로 칸을 나눈다.
 *
 * 카드를 다른 칸에 떨어뜨리면 그 속성 값이 바뀐다 — 보드의 존재 이유가 이것이다.
 * 드래그는 이미 의존성에 있는 @dnd-kit 을 쓴다 (사이드바 트리와 같은 라이브러리).
 */
import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  closestCenter, DndContext, KeyboardCode, KeyboardSensor, PointerSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { Plus } from 'lucide-react'
import type { PropertyDef } from '@/lib/core/schema'
import {
  groupRows, isEmptyValue, valueOf, type CollectionRowData,
} from '@/lib/collection-query'
import { formatDateTime, type Member } from './PropertyCell'

export function BoardView({
  schema, rows, members, canEdit, groupBy,
  onCellChange, onAddRow,
}: {
  schema: PropertyDef[]
  rows: CollectionRowData[]
  members: Member[]
  canEdit: boolean
  groupBy?: string
  onCellChange: (rowId: string, propId: string, value: unknown) => void
  onAddRow: (groupValue: string) => void
}) {
  const groupProp = schema.find((p) => p.id === groupBy)

  /**
   * PointerSensor: 살짝 끌어야 드래그로 친다 — 안 그러면 카드 클릭이 전부 드래그가 된다.
   * KeyboardSensor: 직접 넘기면 dnd-kit 의 기본 센서를 **대체**하므로 여기서 다시 넣어야
   *   한다. 빠뜨리면 카드가 스페이스/방향키로 옮겨지지 않는다 (카드에 붙는 안내 문구는
   *   그대로 남아서, 화면 낭독기 사용자에게 되지도 않는 조작을 안내하게 된다).
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: jumpToNextColumn }),
  )

  if (!groupProp) {
    return (
      <p className="px-2 py-8 text-center text-sm text-neutral-400">
        그룹 기준이 없습니다. 위의 &ldquo;그룹&rdquo;에서 선택·상태 속성을 고르세요.
      </p>
    )
  }

  const groups = groupRows(schema, rows, groupProp.id)

  const handleDragEnd = (e: DragEndEvent) => {
    if (!e.over) return
    const rowId = String(e.active.id)
    const target = String(e.over.id)

    const row = rows.find((r) => r.id === rowId)
    if (!row) return

    const current = valueOf(groupProp, row)
    const currentKey = isEmptyValue(current) ? '' : String(current)
    if (currentKey === target) return

    onCellChange(rowId, groupProp.id, target === '' ? null : target)
  }

  return (
    /**
     * ★ collisionDetection 을 closestCenter 로 바꾼다.
     *   기본값(rectIntersection)은 끌린 카드의 사각형이 다른 칸과 **겹쳐야** 인정한다.
     *   칸 하나가 화면에서 넓다 보니 카드를 옆 칸까지 끌어도 원래 칸과의 교차가 남아
     *   over 가 계속 원래 칸으로 잡혔고, 그래서 드롭이 조용히 무시됐다.
     *   중심 거리로 판정하면 칸 경계를 넘는 순간 바로 넘어간다.
     */
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {groups.map((g) => (
          <Column
            key={g.key || '__none__'}
            id={g.key}
            label={g.label}
            count={g.rows.length}
            canEdit={canEdit}
            onAddRow={() => onAddRow(g.key)}
          >
            {g.rows.map((row) => (
              <Card
                key={row.id}
                row={row}
                schema={schema}
                members={members}
                canDrag={canEdit}
                groupPropId={groupProp.id}
              />
            ))}
          </Column>
        ))}
      </div>
    </DndContext>
  )
}

/**
 * 키보드 드래그에서 ←/→ 를 누르면 **옆 칸으로 통째로** 건너뛴다.
 *
 * dnd-kit 의 기본 좌표 계산기는 한 번에 25px 만 민다. 칸 너비가 256px 이라
 * 칸 하나 옮기는 데 열 번 넘게 눌러야 해서 사실상 못 쓴다.
 */
const jumpToNextColumn: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const dir =
    event.code === KeyboardCode.Right ? 1 :
    event.code === KeyboardCode.Left ? -1 : 0
  if (dir === 0) return

  const columns = [...context.droppableRects.values()].sort((a, b) => a.left - b.left)
  const cur = context.collisionRect
  if (columns.length < 2 || !cur) return

  const center = cur.left + cur.width / 2
  let idx = 0
  let best = Infinity
  columns.forEach((r, i) => {
    const d = Math.abs(r.left + r.width / 2 - center)
    if (d < best) { best = d; idx = i }
  })

  const nextIdx = Math.min(columns.length - 1, Math.max(0, idx + dir))
  if (nextIdx === idx) return

  return {
    x: currentCoordinates.x + (columns[nextIdx].left - columns[idx].left),
    y: currentCoordinates.y,
  }
}

function Column({
  id, label, count, canEdit, onAddRow, children,
}: {
  id: string
  label: string
  count: number
  canEdit: boolean
  onAddRow: () => void
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={
        'flex w-64 shrink-0 flex-col gap-2 rounded-lg p-2 transition-colors ' +
        (isOver ? 'bg-neutral-200 dark:bg-neutral-800' : 'bg-neutral-50 dark:bg-neutral-900/50')
      }
    >
      <div className="flex items-center gap-2 px-1 text-xs font-medium text-neutral-500">
        <span className="truncate">{label}</span>
        <span className="text-neutral-400">{count}</span>
      </div>

      {children}

      {canEdit && (
        <button
          type="button"
          onClick={onAddRow}
          className="flex items-center gap-1 rounded px-1 py-1 text-xs text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800"
        >
          <Plus className="size-3.5" /> 새 항목
        </button>
      )}
    </div>
  )
}

function Card({
  row, schema, members, canDrag, groupPropId,
}: {
  row: CollectionRowData
  schema: PropertyDef[]
  members: Member[]
  canDrag: boolean
  groupPropId: string
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: row.id,
    disabled: !canDrag,
  })

  // 그룹 기준 속성은 칸 제목이 이미 말해주므로 카드에서는 뺀다
  const shown = schema
    .filter((p) => p.type !== 'title' && p.id !== groupPropId)
    .slice(0, 3)

  return (
    <div
      ref={setNodeRef}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      className={
        'rounded-md border border-neutral-200 bg-white p-2 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 ' +
        (isDragging ? 'opacity-50' : '')
      }
      {...attributes}
      {...listeners}
    >
      <Link
        href={`/p/${row.id}`}
        className="block truncate text-sm hover:underline"
        // 드래그를 끝낸 클릭이 링크로 새지 않게 한다
        onClick={(e) => { if (isDragging) e.preventDefault() }}
      >
        {row.icon?.type === 'emoji' && <span className="mr-1">{row.icon.value}</span>}
        {row.title || '제목 없음'}
      </Link>

      {shown.map((p) => {
        const v = valueOf(p, row)
        if (isEmptyValue(v)) return null
        return (
          <p key={p.id} className="mt-1 truncate text-xs text-neutral-500">
            {p.name}: {display(v, members)}
          </p>
        )
      })}
    </div>
  )
}

function display(v: unknown, members: Member[]): string {
  if (v instanceof Date) return formatDateTime(v)
  if (Array.isArray(v)) {
    return v.map((x) => members.find((m) => m.id === x)?.displayName ?? String(x)).join(', ')
  }
  if (typeof v === 'object' && v !== null && 'start' in v) {
    return String((v as { start: unknown }).start)
  }
  if (typeof v === 'boolean') return v ? '✓' : ''
  return String(v)
}
