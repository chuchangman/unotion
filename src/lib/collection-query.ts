/**
 * 컬렉션의 순수 계산부 — 값 읽기 / 필터 / 정렬 / 그룹.
 *
 * ★ 이 파일에는 React 도 DB 도 넣지 않는다.
 *   서버(lib/core/collections.ts)와 클라이언트(components/collection/*)가
 *   **같은 규칙**으로 값을 해석해야 하기 때문이다. 규칙이 갈라지면
 *   표에 보이는 값과 필터가 거른 값이 달라진다.
 *   (lib/page-board.ts 와 같은 이유로 분리된 파일이다.)
 */
import type { PropertyDef, PropertyType } from './core/schema'

/** 한 행(=페이지)의 표시용 형태. 본문(ydoc/contentJson)은 절대 싣지 않는다. */
export type CollectionRowData = {
  id: string
  title: string
  icon: { type: 'emoji' | 'url'; value: string } | null
  properties: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
  lastEditedBy: string | null
}

export type FilterOp =
  | 'is' | 'is_not'
  | 'contains' | 'not_contains'
  | 'is_empty' | 'is_not_empty'
  | 'gt' | 'gte' | 'lt' | 'lte'

export type Filter = { propId: string; op: FilterOp; value?: unknown }
export type Sort = { propId: string; direction: 'asc' | 'desc' }

export type ViewConfig = {
  filters?: Filter[]
  sorts?: Sort[]
  /** select / status / checkbox / person 속성의 id */
  groupBy?: string
  /** 지정하면 이 순서로만 보인다. 없으면 스키마 순서 전체 */
  visibleProps?: string[]
  colWidths?: Record<string, number>
}

/** select 계열 속성의 옵션 */
export type SelectOption = { id: string; name: string; color?: string }

/** 날짜 속성의 값 */
export type DateValue = { start: string; end?: string }

/** pages 컬럼에서 파생되는(= properties 에 저장하지 않는) 속성 타입 */
const DERIVED: ReadonlySet<PropertyType> = new Set([
  'title', 'created_time', 'last_edited_time', 'created_by', 'last_edited_by',
])

export const isDerived = (t: PropertyType) => DERIVED.has(t)

/** 표시만 하고 사용자가 직접 못 고치는 타입 */
export const isReadOnly = (t: PropertyType) =>
  t === 'created_time' || t === 'last_edited_time' || t === 'created_by' || t === 'last_edited_by'

export const hasOptions = (t: PropertyType) =>
  t === 'select' || t === 'multi_select' || t === 'status'

/** 속성 추가 메뉴에 보여줄 이름들. 여기 없는 타입은 아직 지원하지 않는다. */
export const PROPERTY_TYPE_LABELS: Partial<Record<PropertyType, string>> = {
  text: '텍스트',
  number: '숫자',
  select: '선택',
  multi_select: '다중 선택',
  status: '상태',
  date: '날짜',
  person: '사람',
  checkbox: '체크박스',
  url: 'URL',
  email: '이메일',
  phone: '전화',
  created_time: '생성 일시',
  last_edited_time: '최종 편집 일시',
  created_by: '만든 사람',
  last_edited_by: '최종 편집자',
}

/** 속성 하나의 실제 값. 파생 타입은 pages 컬럼에서 읽는다. */
export function valueOf(prop: PropertyDef, row: CollectionRowData): unknown {
  switch (prop.type) {
    case 'title': return row.title
    case 'created_time': return row.createdAt
    case 'last_edited_time': return row.updatedAt
    case 'created_by': return row.createdBy
    case 'last_edited_by': return row.lastEditedBy
    default: return row.properties[prop.id]
  }
}

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object' && v !== null && 'start' in v) {
    return !(v as { start?: unknown }).start
  }
  return false
}

/** 비교 가능한 원시값으로 정규화 */
function sortable(prop: PropertyDef, row: CollectionRowData): string | number | null {
  const v = valueOf(prop, row)
  if (isEmptyValue(v)) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (Array.isArray(v)) return v.join(', ').toLowerCase()
  if (typeof v === 'object' && v !== null && 'start' in v) {
    return String((v as { start: unknown }).start)
  }
  return String(v).toLowerCase()
}

/** null 은 항상 뒤로 보낸다 — 빈 칸이 위에 몰리면 표를 읽을 수 없다 */
function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'ko')
}

function asText(x: unknown): string {
  if (Array.isArray(x)) return x.join(' ').toLowerCase()
  if (x instanceof Date) return x.toISOString()
  if (typeof x === 'object' && x !== null && 'start' in x) {
    return String((x as { start: unknown }).start)
  }
  return String(x ?? '').toLowerCase()
}

function matches(f: Filter, prop: PropertyDef, row: CollectionRowData): boolean {
  const v = valueOf(prop, row)

  if (f.op === 'is_empty') return isEmptyValue(v)
  if (f.op === 'is_not_empty') return !isEmptyValue(v)
  if (isEmptyValue(v)) return false

  switch (f.op) {
    case 'is':
      return Array.isArray(v)
        ? v.map(String).includes(String(f.value))
        : asText(v) === asText(f.value)
    case 'is_not':
      return Array.isArray(v)
        ? !v.map(String).includes(String(f.value))
        : asText(v) !== asText(f.value)
    case 'contains':
      return asText(v).includes(asText(f.value))
    case 'not_contains':
      return !asText(v).includes(asText(f.value))
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = sortable(prop, row)
      if (a === null) return false
      const b = typeof f.value === 'number' ? f.value : String(f.value ?? '').toLowerCase()
      const c = compare(a, b)
      return f.op === 'gt' ? c > 0 : f.op === 'gte' ? c >= 0 : f.op === 'lt' ? c < 0 : c <= 0
    }
    default:
      return true
  }
}

/** 뷰 설정(필터 + 정렬)을 행 목록에 적용한다. 서버와 클라이언트가 같이 쓴다. */
export function applyView(
  schema: PropertyDef[],
  rows: CollectionRowData[],
  config: ViewConfig,
): CollectionRowData[] {
  const byId = new Map(schema.map((p) => [p.id, p]))
  let out = rows

  for (const f of config.filters ?? []) {
    const prop = byId.get(f.propId)
    if (!prop) continue
    out = out.filter((r) => matches(f, prop, r))
  }

  // 뒤쪽 정렬부터 적용해야 앞쪽 정렬이 1순위가 된다 (Array.sort 는 안정 정렬)
  for (const s of [...(config.sorts ?? [])].reverse()) {
    const prop = byId.get(s.propId)
    if (!prop) continue
    const dir = s.direction === 'desc' ? -1 : 1
    out = [...out].sort((a, b) => dir * compare(sortable(prop, a), sortable(prop, b)))
  }

  return out
}

/** groupBy 가 있는 뷰(보드)용. 그룹 순서는 스키마의 옵션 순서를 따른다. */
export function groupRows(
  schema: PropertyDef[],
  rows: CollectionRowData[],
  groupBy: string,
): { key: string; label: string; rows: CollectionRowData[] }[] {
  const prop = schema.find((p) => p.id === groupBy)
  if (!prop) return [{ key: '', label: '전체', rows }]

  const buckets = new Map<string, CollectionRowData[]>()
  for (const row of rows) {
    const v = valueOf(prop, row)
    const keys = Array.isArray(v)
      ? (v.length ? v.map(String) : [''])
      : [isEmptyValue(v) ? '' : String(v)]
    for (const k of keys) {
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k)!.push(row)
    }
  }

  const options = ((prop.config?.options as SelectOption[] | undefined) ?? []).map((o) => o.name)

  // 옵션 순서를 먼저. 행이 없는 옵션 칸도 보여야 드래그로 옮길 자리가 생긴다
  const out = options.map((o) => ({ key: o, label: o, rows: buckets.get(o) ?? [] }))
  for (const k of buckets.keys()) {
    if (k !== '' && !options.includes(k)) {
      out.push({ key: k, label: k, rows: buckets.get(k)! })
    }
  }
  out.push({ key: '', label: '미지정', rows: buckets.get('') ?? [] })
  return out
}
