'use client'

/**
 * 데이터베이스 화면의 껍데기 — 뷰 탭, 도구 모음, 그리고 표/보드.
 *
 * ★ 낙관적 갱신을 쓴다.
 *   Next 16 은 서버 액션을 클라이언트당 순차 디스패치한다. 셀 하나 고칠 때마다
 *   응답을 기다렸다 그리면 연속 편집이 눈에 띄게 밀린다. 그래서 화면을 먼저 바꾸고
 *   실패하면 되돌린다.
 *
 * 정렬·그룹은 클라이언트에서 즉시 적용하고(applyView — 서버와 같은 규칙 파일),
 * 뷰 설정만 뒤에서 저장한다.
 */
import { useState, useTransition } from 'react'
import { Columns3, Plus, Table2 } from 'lucide-react'
import type { PropertyDef, PropertyType, ViewType } from '@/lib/core/schema'
import {
  applyView, hasOptions,
  type CollectionRowData, type SelectOption, type Sort, type ViewConfig,
} from '@/lib/collection-query'
import type { ActionResult, CollectionPayload } from '@/app/actions/collections'
import * as Actions from '@/app/actions/collections'
import { TableView } from './TableView'
import { BoardView } from './BoardView'
import type { Member } from './PropertyCell'

export function CollectionView({
  initial, members, canEdit,
}: {
  initial: CollectionPayload
  members: Member[]
  canEdit: boolean
}) {
  const collectionId = initial.collection.id

  const [views, setViews] = useState(initial.views)
  const [activeId, setActiveId] = useState(initial.activeViewId)
  const [schema, setSchema] = useState<PropertyDef[]>(initial.schema)
  const [rows, setRows] = useState<CollectionRowData[]>(initial.rows)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()

  const view = views.find((v) => v.id === activeId) ?? views[0]
  const config = (view?.config ?? {}) as ViewConfig
  const sorts = config.sorts ?? []
  const shown = applyView(schema, rows, { sorts })

  /** 액션 결과를 확인하고, 실패하면 되돌리기 콜백을 실행한다 */
  function guard<T>(p: Promise<ActionResult<T>>, revert?: () => void) {
    startTransition(async () => {
      const res = await p
      if (res.ok) setError('')
      else { setError(res.message); revert?.() }
    })
  }

  // ── 행

  const patchRow = (rowId: string, patch: Partial<CollectionRowData>) =>
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)))

  /**
   * 셀에서 처음 쓰인 선택 값을 속성 스키마에 등록한다.
   *
   * 이게 없으면 값은 그 행에만 남고 다른 행의 드롭다운에는 안 뜬다 —
   * 같은 태그를 행마다 다시 타이핑하게 된다. 보드의 칸 순서도 이 목록을 따른다.
   */
  const registerNewOptions = (propId: string, value: unknown) => {
    const prop = schema.find((p) => p.id === propId)
    if (!prop || !hasOptions(prop.type)) return

    const current = (prop.config?.options as SelectOption[] | undefined) ?? []
    const known = new Set(current.map((o) => o.name))
    const incoming = Array.isArray(value)
      ? value.map(String)
      : value === null || value === undefined ? [] : [String(value)]
    const missing = incoming.filter((v) => v && !known.has(v))
    if (missing.length === 0) return

    const options = [...current, ...missing.map((name) => ({ id: crypto.randomUUID(), name }))]
    const config = { ...(prop.config ?? {}), options }

    const beforeSchema = schema
    setSchema((prev) => prev.map((p) => (p.id === propId ? { ...p, config } : p)))
    guard(Actions.updateProperty(collectionId, propId, { config }), () => setSchema(beforeSchema))
  }

  const handleCellChange = (rowId: string, propId: string, value: unknown) => {
    const before = rows.find((r) => r.id === rowId)
    if (!before) return

    const nextProps = { ...before.properties }
    if (value === null || value === undefined) delete nextProps[propId]
    else nextProps[propId] = value

    patchRow(rowId, { properties: nextProps })
    guard(
      Actions.updateRowProperties(rowId, { [propId]: value }),
      () => patchRow(rowId, { properties: before.properties }),
    )
    registerNewOptions(propId, value)
  }

  const handleTitleChange = (rowId: string, title: string) => {
    const before = rows.find((r) => r.id === rowId)
    if (!before) return
    patchRow(rowId, { title })
    guard(Actions.renameRow(rowId, title), () => patchRow(rowId, { title: before.title }))
  }

  const handleAddRow = (groupValue?: string) => {
    const properties: Record<string, unknown> = {}
    if (groupValue && config.groupBy) properties[config.groupBy] = groupValue

    startTransition(async () => {
      const res = await Actions.createRow(collectionId, { properties })
      if (res.ok) setRows((prev) => [...prev, res.data])
      else setError(res.message)
    })
  }

  const handleTrashRow = (rowId: string) => {
    const before = rows
    setRows((prev) => prev.filter((r) => r.id !== rowId))
    guard(Actions.trashRow(rowId), () => setRows(before))
  }

  // ── 속성

  const handleAddProperty = (name: string, type: PropertyType) => {
    startTransition(async () => {
      const res = await Actions.addProperty(collectionId, { name, type })
      if (res.ok) setSchema((prev) => [...prev, res.data])
      else setError(res.message)
    })
  }

  const handleRenameProperty = (propId: string, name: string) => {
    const before = schema
    setSchema((prev) => prev.map((p) => (p.id === propId ? { ...p, name } : p)))
    guard(Actions.updateProperty(collectionId, propId, { name }), () => setSchema(before))
  }

  const handleDeleteProperty = (propId: string) => {
    const beforeSchema = schema
    const beforeRows = rows
    setSchema((prev) => prev.filter((p) => p.id !== propId))
    setRows((prev) => prev.map((r) => {
      const next = { ...r.properties }
      delete next[propId]
      return { ...r, properties: next }
    }))
    guard(Actions.deleteProperty(collectionId, propId), () => {
      setSchema(beforeSchema)
      setRows(beforeRows)
    })
  }

  // ── 뷰

  const saveConfig = (next: ViewConfig) => {
    if (!view) return
    const before = views
    setViews((prev) => prev.map((v) => (v.id === view.id ? { ...v, config: next } : v)))
    guard(Actions.updateView(view.id, { config: next }), () => setViews(before))
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
    startTransition(async () => {
      const res = await Actions.createView(collectionId, { type })
      if (res.ok) {
        setViews((prev) => [...prev, res.data])
        setActiveId(res.data.id)
      } else setError(res.message)
    })
  }

  const groupables = schema.filter((p) => hasOptions(p.type))

  return (
    <section className="mt-6">
      <div className="flex items-center gap-1 border-b border-neutral-200 pb-1 dark:border-neutral-800">
        {views.map((v) => (
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
            schema={schema}
            rows={shown}
            members={members}
            canEdit={canEdit}
            groupBy={config.groupBy}
            onCellChange={handleCellChange}
            onAddRow={handleAddRow}
          />
        ) : (
          <TableView
            schema={schema}
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
