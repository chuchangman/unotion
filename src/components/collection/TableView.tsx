'use client'

/**
 * 표 뷰. 노션의 기본 데이터베이스 뷰에 해당한다.
 *
 * 행은 진짜 페이지이므로 제목 옆의 "열기"로 문서를 연다.
 * 이 컴포넌트는 데이터 상태를 갖지 않는다 — 모든 변경은 부모(CollectionView)로 올린다.
 */
import { useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { PropertyDef, PropertyType } from '@/lib/core/schema'
import { PROPERTY_TYPE_LABELS, type CollectionRowData, type Sort } from '@/lib/collection-query'
import { PropertyCell, type Member } from './PropertyCell'

export function TableView({
  schema, rows, members, canEdit, sorts,
  onCellChange, onTitleChange, onAddRow, onTrashRow,
  onAddProperty, onRenameProperty, onDeleteProperty, onToggleSort,
}: {
  schema: PropertyDef[]
  rows: CollectionRowData[]
  members: Member[]
  canEdit: boolean
  sorts: Sort[]
  onCellChange: (rowId: string, propId: string, value: unknown) => void
  onTitleChange: (rowId: string, title: string) => void
  onAddRow: () => void
  onTrashRow: (rowId: string) => void
  onAddProperty: (name: string, type: PropertyType) => void
  onRenameProperty: (propId: string, name: string) => void
  onDeleteProperty: (propId: string) => void
  onToggleSort: (propId: string) => void
}) {
  const titleProp = schema.find((p) => p.type === 'title')
  const rest = schema.filter((p) => p.type !== 'title')

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-y border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
            <th className="w-[280px] min-w-[280px] px-2 py-1.5 font-medium">
              {titleProp?.name ?? '이름'}
            </th>
            {rest.map((prop) => (
              <th key={prop.id} className="w-[180px] min-w-[180px] p-0 font-medium">
                <ColumnHeader
                  prop={prop}
                  canEdit={canEdit}
                  sort={sorts.find((s) => s.propId === prop.id)}
                  onToggleSort={() => onToggleSort(prop.id)}
                  onRename={(name) => onRenameProperty(prop.id, name)}
                  onDelete={() => onDeleteProperty(prop.id)}
                />
              </th>
            ))}
            <th className="w-10 px-2 py-1.5">
              {canEdit && <AddPropertyButton onAdd={onAddProperty} />}
            </th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="group border-b border-neutral-100 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50"
            >
              <td className="p-0">
                <TitleCell
                  row={row}
                  canEdit={canEdit}
                  onCommit={(title) => onTitleChange(row.id, title)}
                  onTrash={() => onTrashRow(row.id)}
                />
              </td>
              {rest.map((prop) => (
                <td key={prop.id} className="p-0 align-top">
                  <PropertyCell
                    prop={prop}
                    row={row}
                    members={members}
                    canEdit={canEdit}
                    onChange={(propId, value) => onCellChange(row.id, propId, value)}
                  />
                </td>
              ))}
              <td />
            </tr>
          ))}

          {rows.length === 0 && (
            <tr>
              <td
                colSpan={rest.length + 2}
                className="px-2 py-6 text-center text-sm text-neutral-400"
              >
                아직 항목이 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {canEdit && (
        <button
          type="button"
          onClick={onAddRow}
          className="mt-1 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <Plus className="size-4" /> 새 항목
        </button>
      )}
    </div>
  )
}

/**
 * 제목 셀. 입력은 **비제어**다 —
 * 서버 값으로 되돌려 쓰면 남이 같은 행을 고칠 때 내 타이핑이 날아간다.
 */
function TitleCell({
  row, canEdit, onCommit, onTrash,
}: {
  row: CollectionRowData
  canEdit: boolean
  onCommit: (title: string) => void
  onTrash: () => void
}) {
  return (
    <div className="flex items-center gap-1 pr-1">
      {row.icon?.type === 'emoji' && <span className="pl-2 text-sm">{row.icon.value}</span>}
      <input
        defaultValue={row.title}
        placeholder="제목 없음"
        readOnly={!canEdit}
        onBlur={(e) => { if (e.target.value !== row.title) onCommit(e.target.value) }}
        onKeyDown={(e) => {
          const el = e.currentTarget
          if (e.key === 'Enter') el.blur()
          if (e.key === 'Escape') { el.value = row.title; el.blur() }
        }}
        className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-neutral-400 focus:bg-white dark:focus:bg-neutral-900"
      />
      <Link
        href={`/p/${row.id}`}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700"
      >
        열기
      </Link>
      {canEdit && (
        <button
          type="button"
          onClick={onTrash}
          aria-label={`${row.title || '제목 없음'} 삭제`}
          className="shrink-0 rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function ColumnHeader({
  prop, canEdit, sort, onToggleSort, onRename, onDelete,
}: {
  prop: PropertyDef
  canEdit: boolean
  sort?: Sort
  onToggleSort: () => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative flex items-center gap-1 px-2 py-1.5">
      <button
        type="button"
        onClick={onToggleSort}
        title="클릭하면 정렬"
        className="flex min-w-0 items-center gap-1 truncate hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        <span className="truncate">{prop.name}</span>
        {sort?.direction === 'asc' && <ArrowUp className="size-3 shrink-0" />}
        {sort?.direction === 'desc' && <ArrowDown className="size-3 shrink-0" />}
      </button>

      {canEdit && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`${prop.name} 속성 메뉴`}
          className="ml-auto shrink-0 rounded p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      )}

      {open && (
        <>
          <button
            type="button"
            aria-label="메뉴 닫기"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-20 w-40 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            <p className="px-2 py-1 text-[11px] text-neutral-400">
              {PROPERTY_TYPE_LABELS[prop.type] ?? prop.type}
            </p>
            <button
              type="button"
              onClick={() => {
                const name = window.prompt('속성 이름', prop.name)?.trim()
                setOpen(false)
                if (name && name !== prop.name) onRename(name)
              }}
              className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              이름 변경
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                if (confirm(`"${prop.name}" 속성을 지울까요? 모든 항목의 값도 함께 지워집니다.`)) {
                  onDelete()
                }
              }}
              className="w-full rounded px-2 py-1.5 text-left text-sm text-red-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              속성 삭제
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function AddPropertyButton({ onAdd }: { onAdd: (name: string, type: PropertyType) => void }) {
  const [open, setOpen] = useState(false)
  const types = Object.entries(PROPERTY_TYPE_LABELS) as [PropertyType, string][]

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="속성 추가"
        className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700"
      >
        <Plus className="size-4" />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="메뉴 닫기"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-20 max-h-72 w-44 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            {types.map(([type, label]) => (
              <button
                key={type}
                type="button"
                onClick={() => { setOpen(false); onAdd(label, type) }}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
