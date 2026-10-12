'use client'

/**
 * 데이터베이스 화면의 껍데기 — 뷰 탭, 도구 모음, 그리고 표/보드.
 *
 * ★ 낙관적 갱신을 쓴다.
 *   Next 16 은 서버 액션을 클라이언트당 순차 디스패치한다. 셀 하나 고칠 때마다
 *   응답을 기다렸다 그리면 연속 편집이 눈에 띄게 밀린다. 그래서 화면을 먼저 바꾼다.
 *
 * ★ useOptimistic 으로 한다 — 예전의 "통째로 떠 두었다가 되돌리기" 가 아니라.
 *   예전에는 고치기 전 행(스키마, 뷰 목록)을 통째로 떠 두었다가 실패하면 그걸로 되돌렸다.
 *   같은 행을 연달아 두 번 고치고 첫 번째가 실패하면 **두 번째 편집까지** 사라졌다.
 *   이제 확정 상태(rows / schema / views)는 서버 응답으로만 바뀌고, 진행 중인 변경은
 *   그 위에 얹혀 보이기만 한다. 실패한 변경은 그 변경만 떨어진다.
 *
 * 정렬·그룹은 클라이언트에서 즉시 적용하고(applyView — 서버와 같은 규칙 파일),
 * 뷰 설정만 뒤에서 저장한다.
 */
import { useEffect, useOptimistic, useRef, useState, useTransition } from 'react'
import { Columns3, Plus, Table2 } from 'lucide-react'
import type { PropertyDef, PropertyType, ViewType } from '@/lib/core/schema'
import {
  applyView, hasOptions,
  type CollectionRowData, type SelectOption, type Sort, type ViewConfig,
} from '@/lib/collection-query'
import type { CollectionPayload } from '@/app/actions/collections'
import type { ActionResult } from '@/lib/action-result'
import * as Actions from '@/app/actions/collections'
import { getJson, type Jsonified } from '@/lib/api/client'
import { COLLECTION_CHANGED, useWorkspaceSignal } from '@/components/live/WorkspaceLive'
import { TableView } from './TableView'
import { BoardView } from './BoardView'
import type { Member } from './PropertyCell'

type ViewRow = CollectionPayload['views'][number]

// ─────────────────────────────────── 진행 중인 변경 (확정 상태 위에 얹는다)

type RowChange =
  | { type: 'cell'; rowId: string; propId: string; value: unknown }
  | { type: 'title'; rowId: string; title: string }
  | { type: 'trash'; rowId: string }
  | { type: 'dropProp'; propId: string }

function applyRowChange(rows: CollectionRowData[], c: RowChange): CollectionRowData[] {
  switch (c.type) {
    case 'cell':
      return rows.map((r) => {
        if (r.id !== c.rowId) return r
        const properties = { ...r.properties }
        if (c.value === null || c.value === undefined) delete properties[c.propId]
        else properties[c.propId] = c.value
        return { ...r, properties }
      })
    case 'title':
      return rows.map((r) => (r.id === c.rowId ? { ...r, title: c.title } : r))
    case 'trash':
      return rows.filter((r) => r.id !== c.rowId)
    case 'dropProp':
      return rows.map((r) => {
        if (!(c.propId in r.properties)) return r
        const properties = { ...r.properties }
        delete properties[c.propId]
        return { ...r, properties }
      })
  }
}

type SchemaChange =
  | { type: 'rename'; propId: string; name: string }
  | { type: 'delete'; propId: string }
  | { type: 'options'; propId: string; names: string[] }

function applySchemaChange(schema: PropertyDef[], c: SchemaChange): PropertyDef[] {
  switch (c.type) {
    case 'rename':
      return schema.map((p) => (p.id === c.propId ? { ...p, name: c.name } : p))
    case 'delete':
      return schema.filter((p) => p.id !== c.propId)
    case 'options':
      return schema.map((p) => {
        if (p.id !== c.propId) return p
        const current = (p.config?.options as SelectOption[] | undefined) ?? []
        const known = new Set(current.map((o) => o.name))
        const added = c.names.filter((n) => !known.has(n)).map((name) => ({ id: `pending:${name}`, name }))
        return { ...p, config: { ...(p.config ?? {}), options: [...current, ...added] } }
      })
  }
}

type ViewChange = { viewId: string; config: ViewConfig }

function applyViewChange(views: ViewRow[], c: ViewChange): ViewRow[] {
  return views.map((v) => (v.id === c.viewId ? { ...v, config: c.config } : v))
}

// ───────────────────────────────────

export function CollectionView({
  initial, members, canEdit,
}: {
  initial: CollectionPayload
  members: Member[]
  canEdit: boolean
}) {
  const collectionId = initial.collection.id

  // 확정 상태 — 서버 응답으로만 바뀐다
  const [views, setViews] = useState(initial.views)
  const [schema, setSchema] = useState<PropertyDef[]>(initial.schema)
  const [rows, setRows] = useState<CollectionRowData[]>(initial.rows)
  const [activeId, setActiveId] = useState(initial.activeViewId)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()
  const emit = useWorkspaceSignal()

  // 보이는 상태 — 확정 상태 + 아직 응답을 못 받은 변경
  const [shownRows, addRowChange] = useOptimistic(rows, applyRowChange)
  const [shownSchema, addSchemaChange] = useOptimistic(schema, applySchemaChange)
  const [shownViews, addViewChange] = useOptimistic(views, applyViewChange)

  /**
   * 다시 읽기와 내 변경의 순서. 다시 읽기가 떠난 **뒤에** 내 변경이 확정되면 그 응답은 내 변경을
   * 모를 수 있다 — 그대로 쓰면 방금 고친 칸이 옛 값으로 돌아간다. 그럴 땐 버리고 한 번 더 읽는다.
   */
  const order = useRef({ tick: 0, latestFetch: 0, lastCommit: 0 })

  /**
   * 다른 사람이 이 표를 고쳤다는 신호 (components/live/WorkspaceLive.tsx).
   * 행과 스키마를 다시 읽어 **확정 상태**만 바꾼다 — 진행 중인 내 변경은 그 위에 그대로 얹힌다.
   */
  useEffect(() => {
    const o = order.current
    const refetch = () => {
      const started = (o.latestFetch = ++o.tick)
      void getJson<{ schema: PropertyDef[]; rows: Jsonified<CollectionRowData>[] }>(
        `/api/collections/${collectionId}/rows`,
      )
        .then((fresh) => {
          if (started !== o.latestFetch) return // 더 나중에 떠난 읽기가 있다
          if (o.lastCommit > started) return refetch()
          startTransition(() => {
            setSchema(fresh.schema)
            setRows(fresh.rows.map((r) => ({
              ...r,
              createdAt: new Date(r.createdAt),
              updatedAt: new Date(r.updatedAt),
            })))
          })
        })
        .catch((err) => console.error('[collection] 다시 읽기 실패', err))
    }
    const onChange = (e: Event) => {
      if ((e as CustomEvent<{ id?: string }>).detail?.id === collectionId) refetch()
    }
    window.addEventListener(COLLECTION_CHANGED, onChange)
    return () => window.removeEventListener(COLLECTION_CHANGED, onChange)
  }, [collectionId])

  const view = shownViews.find((v) => v.id === activeId) ?? shownViews[0]
  const config = (view?.config ?? {}) as ViewConfig
  const sorts = config.sorts ?? []
  const shown = applyView(shownSchema, shownRows, { sorts })

  /**
   * 변경 하나를 보낸다. optimistic 은 화면에 바로 얹고, 성공하면 commit 으로 확정 상태를
   * 고친다. 실패하면 아무것도 안 해도 된다 — 전환이 끝나면서 그 변경만 사라진다.
   *
   * notify: 다른 사람에게 알릴지. 받는 쪽은 행과 스키마만 다시 읽으므로 뷰 설정(정렬·그룹)의
   * 변경은 알려 봐야 헛읽기다.
   */
  function mutate<T>(
    optimistic: () => void,
    send: () => Promise<ActionResult<T>>,
    commit: (data: T) => void,
    { notify = true }: { notify?: boolean } = {},
  ) {
    startTransition(async () => {
      optimistic()
      const res = await send()
      if (!res.ok) {
        setError(res.message)
        return
      }
      setError('')
      order.current.lastCommit = ++order.current.tick
      if (notify) emit({ kind: 'collection', id: collectionId }) // 이 표를 보고 있는 다른 사람도
      // await 뒤의 상태 갱신은 전환 밖으로 새므로 다시 전환으로 묶는다 (React 19 의 제약)
      startTransition(() => commit(res.data))
    })
  }

  const replaceRow = (row: CollectionRowData) =>
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)))
  const replaceProp = (prop: PropertyDef) =>
    setSchema((prev) => prev.map((p) => (p.id === prop.id ? prop : p)))

  // ── 행

  /**
   * 셀에서 처음 쓰인 선택 값을 속성 스키마에 등록한다.
   *
   * 이게 없으면 값은 그 행에만 남고 다른 행의 드롭다운에는 안 뜬다 —
   * 같은 태그를 행마다 다시 타이핑하게 된다. 보드의 칸 순서도 이 목록을 따른다.
   * 서버는 **없는 이름만 덧붙인다**(addSelectOptions) — 두 사람이 동시에 다른 새 태그를
   * 써도 둘 다 남는다. 예전에는 선택지 목록을 통째로 갈아끼워서 한쪽이 지워졌다.
   */
  const registerNewOptions = (propId: string, value: unknown) => {
    const prop = shownSchema.find((p) => p.id === propId)
    if (!prop || !hasOptions(prop.type)) return

    const known = new Set(((prop.config?.options as SelectOption[] | undefined) ?? []).map((o) => o.name))
    const incoming = Array.isArray(value)
      ? value.map(String)
      : value === null || value === undefined ? [] : [String(value)]
    const missing = incoming.filter((v) => v && !known.has(v))
    if (missing.length === 0) return

    mutate(
      () => addSchemaChange({ type: 'options', propId, names: missing }),
      () => Actions.addSelectOptions(collectionId, propId, missing),
      replaceProp,
    )
  }

  const handleCellChange = (rowId: string, propId: string, value: unknown) => {
    mutate(
      () => addRowChange({ type: 'cell', rowId, propId, value }),
      () => Actions.updateRowProperties(rowId, { [propId]: value }),
      replaceRow,
    )
    registerNewOptions(propId, value)
  }

  const handleTitleChange = (rowId: string, title: string) => {
    mutate(
      () => addRowChange({ type: 'title', rowId, title }),
      () => Actions.renameRow(rowId, title),
      () => setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, title } : r))),
    )
  }

  const handleAddRow = (groupValue?: string) => {
    const properties: Record<string, unknown> = {}
    if (groupValue && config.groupBy) properties[config.groupBy] = groupValue

    // 새 행의 id 는 서버가 정한다 — 낙관적으로 그리지 않는다
    mutate(
      () => {},
      () => Actions.createRow(collectionId, { properties }),
      (row) => setRows((prev) => [...prev, row]),
    )
  }

  const handleTrashRow = (rowId: string) => {
    mutate(
      () => addRowChange({ type: 'trash', rowId }),
      () => Actions.trashRow(rowId),
      () => setRows((prev) => prev.filter((r) => r.id !== rowId)),
    )
  }

  // ── 속성

  const handleAddProperty = (name: string, type: PropertyType) => {
    mutate(
      () => {},
      () => Actions.addProperty(collectionId, { name, type }),
      (prop) => setSchema((prev) => [...prev, prop]),
    )
  }

  const handleRenameProperty = (propId: string, name: string) => {
    mutate(
      () => addSchemaChange({ type: 'rename', propId, name }),
      () => Actions.updateProperty(collectionId, propId, { name }),
      replaceProp,
    )
  }

  const handleDeleteProperty = (propId: string) => {
    mutate(
      () => {
        addSchemaChange({ type: 'delete', propId })
        addRowChange({ type: 'dropProp', propId })
      },
      () => Actions.deleteProperty(collectionId, propId),
      () => {
        setSchema((prev) => prev.filter((p) => p.id !== propId))
        setRows((prev) => applyRowChange(prev, { type: 'dropProp', propId }))
      },
    )
  }

  // ── 뷰

  const saveConfig = (next: ViewConfig) => {
    if (!view) return
    const viewId = view.id
    mutate(
      () => addViewChange({ viewId, config: next }),
      () => Actions.updateView(viewId, { config: next }),
      (row) => setViews((prev) => prev.map((v) => (v.id === row.id ? row : v))),
      { notify: false },
    )
  }

  /** 오름차순 → 내림차순 → 해제 */
  const handleToggleSort = (propId: string) => {
    const current = sorts.find((s) => s.propId === propId)
    const next: Sort[] =
      !current ? [{ propId, direction: 'asc' }]
      : current.direction === 'asc' ? [{ propId, direction: 'desc' }]
      : []
    saveConfig({ ...config, sorts: next })
  }

  const handleAddView = (type: ViewType) => {
    mutate(
      () => {},
      () => Actions.createView(collectionId, { type }),
      (row) => {
        setViews((prev) => [...prev, row])
        setActiveId(row.id)
      },
      { notify: false },
    )
  }

  const groupables = shownSchema.filter((p) => hasOptions(p.type))

  return (
    <section className="mt-6">
      <div className="flex items-center gap-1 border-b border-neutral-200 pb-1 dark:border-neutral-800">
        {shownViews.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setActiveId(v.id)}
            className={
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ' +
              (v.id === activeId
                ? 'bg-neutral-100 font-medium dark:bg-neutral-800'
                : 'text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-900')
            }
          >
            {v.type === 'board'
              ? <Columns3 className="size-3.5" />
              : <Table2 className="size-3.5" />}
            {v.name}
          </button>
        ))}

        {canEdit && (
          <>
            <button
              type="button"
              onClick={() => handleAddView('table')}
              title="표 뷰 추가"
              aria-label="표 뷰 추가"
              className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <Plus className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleAddView('board')}
              className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              보드 추가
            </button>
          </>
        )}

        {view?.type === 'board' && canEdit && (
          <label className="ml-auto flex items-center gap-1 text-xs text-neutral-500">
            그룹
            <select
              value={config.groupBy ?? ''}
              onChange={(e) => saveConfig({ ...config, groupBy: e.target.value || undefined })}
              className="rounded border border-neutral-200 bg-transparent px-1 py-0.5 text-xs dark:border-neutral-700"
            >
              <option value="">—</option>
              {groupables.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {initial.truncated && (
        <p className="mt-2 text-xs text-neutral-400">
          항목이 너무 많아 일부만 보여줍니다 (최대 1,000개).
        </p>
      )}

      <div className="mt-2">
        {view?.type === 'board' ? (
          <BoardView
            schema={shownSchema}
            rows={shown}
            members={members}
            canEdit={canEdit}
            groupBy={config.groupBy}
            onCellChange={handleCellChange}
            onAddRow={handleAddRow}
          />
        ) : (
          <TableView
            schema={shownSchema}
            rows={shown}
            members={members}
            canEdit={canEdit}
            sorts={sorts}
            onCellChange={handleCellChange}
            onTitleChange={handleTitleChange}
            onAddRow={() => handleAddRow()}
            onTrashRow={handleTrashRow}
            onAddProperty={handleAddProperty}
            onRenameProperty={handleRenameProperty}
            onDeleteProperty={handleDeleteProperty}
            onToggleSort={handleToggleSort}
          />
        )}
      </div>
    </section>
  )
}
