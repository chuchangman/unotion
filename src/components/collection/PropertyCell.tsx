'use client'

/**
 * 속성 하나를 그리고 편집하는 셀.
 *
 * 값의 해석 규칙은 lib/collection-query.ts 하나에만 있다 (서버와 공유).
 * 여기는 그 값을 어떻게 보여주고 어떻게 되돌려줄지만 정한다.
 *
 * 저장은 타이핑마다가 아니라 **셀에서 포커스가 빠질 때**(onBlur) 한다.
 * 글자마다 서버 액션을 부르면 Next 가 액션을 순차 디스패치하느라 표가 밀린다.
 */
import { X } from 'lucide-react'
import type { PropertyDef } from '@/lib/core/schema'
import {
  isReadOnly, valueOf, type CollectionRowData, type DateValue, type SelectOption,
} from '@/lib/collection-query'

export type Member = { id: string; displayName: string; email: string }

const INPUT =
  'w-full bg-transparent px-2 py-1 text-sm outline-none focus:bg-white dark:focus:bg-neutral-900'

const NEW_OPTION = '__new__'

export function formatDateTime(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d)
  return date.toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function optionsOf(prop: PropertyDef): SelectOption[] {
  return (prop.config?.options as SelectOption[] | undefined) ?? []
}

export function PropertyCell({
  prop, row, members, canEdit, onChange,
}: {
  prop: PropertyDef
  row: CollectionRowData
  members: Member[]
  canEdit: boolean
  onChange: (propId: string, value: unknown) => void
}) {
  const value = valueOf(prop, row)
  const nameOf = (id: unknown) =>
    members.find((m) => m.id === id)?.displayName ?? (id ? '알 수 없음' : '')

  if (isReadOnly(prop.type)) {
    const text =
      prop.type === 'created_time' || prop.type === 'last_edited_time'
        ? (value ? formatDateTime(value as Date) : '')
        : nameOf(value)
    return <span className="block truncate px-2 py-1 text-sm text-neutral-500">{text}</span>
  }

  switch (prop.type) {
    case 'checkbox':
      return (
        <span className="flex items-center px-2 py-1">
          <input
            type="checkbox"
            checked={value === true}
            disabled={!canEdit}
            onChange={(e) => onChange(prop.id, e.target.checked ? true : null)}
            className="size-4 accent-neutral-900 dark:accent-neutral-100"
          />
        </span>
      )

    case 'number':
      return (
        <TextLike
          value={value === undefined || value === null ? '' : String(value)}
          canEdit={canEdit}
          type="number"
          onCommit={(next) => onChange(prop.id, next === '' ? null : Number(next))}
        />
      )

    case 'date':
      return (
        <TextLike
          value={(value as DateValue | undefined)?.start ?? ''}
          canEdit={canEdit}
          type="date"
          onCommit={(next) => onChange(prop.id, next ? { start: next } : null)}
        />
      )

    case 'select':
    case 'status':
      return (
        <SingleSelect
          prop={prop}
          value={typeof value === 'string' ? value : ''}
          canEdit={canEdit}
          onChange={(next) => onChange(prop.id, next || null)}
        />
      )

    case 'multi_select':
      return (
        <MultiSelect
          options={optionsOf(prop).map((o) => o.name)}
          value={Array.isArray(value) ? (value as string[]) : []}
          canEdit={canEdit}
          allowNew
          onChange={(next) => onChange(prop.id, next.length ? next : null)}
        />
      )

    case 'person':
      return (
        <MultiSelect
          options={members.map((m) => m.id)}
          labelOf={nameOf}
          value={Array.isArray(value) ? (value as string[]) : []}
          canEdit={canEdit}
          onChange={(next) => onChange(prop.id, next.length ? next : null)}
        />
      )

    default:
      // text / url / email / phone
      return (
        <TextLike
          value={typeof value === 'string' ? value : ''}
          canEdit={canEdit}
          type={prop.type === 'url' ? 'url' : prop.type === 'email' ? 'email' : 'text'}
          onCommit={(next) => onChange(prop.id, next || null)}
        />
      )
  }
}

/**
 * 입력형 셀. **비제어**다 — 서버 값으로 계속 되돌려 쓰면
 * 다른 사람이 같은 행을 고칠 때 내 타이핑이 날아간다.
 * 커밋(onBlur) 후에는 낙관적 갱신으로 어차피 같은 값이 된다.
 */
function TextLike({
  value, canEdit, type, onCommit,
}: {
  value: string
  canEdit: boolean
  type: 'text' | 'number' | 'date' | 'url' | 'email'
  onCommit: (next: string) => void
}) {
  if (!canEdit) {
    return <span className="block truncate px-2 py-1 text-sm">{value}</span>
  }

  return (
    <input
      type={type}
      defaultValue={value}
      onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value) }}
      onKeyDown={(e) => {
        const el = e.currentTarget
        if (e.key === 'Enter') el.blur()
        if (e.key === 'Escape') { el.value = value; el.blur() }
      }}
      className={INPUT}
    />
  )
}

function SingleSelect({
  prop, value, canEdit, onChange,
}: {
  prop: PropertyDef
  value: string
  canEdit: boolean
  onChange: (next: string) => void
}) {
  const options = optionsOf(prop)

  if (!canEdit) {
    return value ? <span className="block px-2 py-1"><Chip label={value} /></span> : <span className="block px-2 py-1" />
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === NEW_OPTION) {
          const name = window.prompt('새 옵션 이름')?.trim()
          if (name) onChange(name)
          return
        }
        onChange(e.target.value)
      }}
      className={INPUT + ' cursor-pointer'}
    >
      <option value="">—</option>
      {options.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
      {/* 스키마에 없는 값이 이미 들어 있으면 그대로 유지되도록 남긴다 */}
      {value && !options.some((o) => o.name === value) && <option value={value}>{value}</option>}
      <option value={NEW_OPTION}>＋ 새 옵션…</option>
    </select>
  )
}

function MultiSelect({
  options, value, canEdit, onChange, labelOf, allowNew = false,
}: {
  options: string[]
  value: string[]
  canEdit: boolean
  onChange: (next: string[]) => void
  labelOf?: (v: string) => string
  allowNew?: boolean
}) {
  const label = labelOf ?? ((v: string) => v)
  const remaining = options.filter((o) => !value.includes(o))

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1">
      {value.map((v) => (
        <Chip
          key={v}
          label={label(v)}
          onRemove={canEdit ? () => onChange(value.filter((x) => x !== v)) : undefined}
        />
      ))}
      {canEdit && (
        <select
          value=""
          aria-label="값 추가"
          onChange={(e) => {
            if (!e.target.value) return
            if (e.target.value === NEW_OPTION) {
              const name = window.prompt('새 옵션 이름')?.trim()
              if (name && !value.includes(name)) onChange([...value, name])
              return
            }
            onChange([...value, e.target.value])
          }}
          className="cursor-pointer bg-transparent text-xs text-neutral-400 outline-none"
        >
          <option value="">＋</option>
          {remaining.map((o) => <option key={o} value={o}>{label(o)}</option>)}
          {allowNew && <option value={NEW_OPTION}>＋ 새 옵션…</option>}
        </select>
      )}
    </div>
  )
}

function Chip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-700">
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${label} 제거`}
          className="hover:text-red-600"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
