import { describe, expect, it } from 'vitest'
import { applyView, groupRows, type CollectionRowData } from './collection-query'
import type { PropertyDef } from './core/schema'

const schema: PropertyDef[] = [
  { id: 'title', name: '이름', type: 'title' },
  { id: 'st', name: '상태', type: 'status', config: { options: [{ id: 'a', name: '할 일' }, { id: 'b', name: '진행 중' }, { id: 'c', name: '완료' }] } },
  { id: 'n', name: '점수', type: 'number' },
  { id: 'tags', name: '태그', type: 'multi_select', config: { options: [{ id: 'x', name: '백엔드' }, { id: 'y', name: '프론트' }] } },
  { id: 'due', name: '마감', type: 'date' },
]

function row(id: string, title: string, properties: Record<string, unknown>): CollectionRowData {
  const at = new Date('2026-09-01T00:00:00Z')
  return { id, title, icon: null, properties, createdAt: at, updatedAt: at, createdBy: null, lastEditedBy: null }
}

const rows = [
  row('1', '다', { st: '완료', n: 3, tags: ['백엔드'], due: { start: '2026-09-10' } }),
  row('2', '가', { st: '할 일', n: 10, tags: ['백엔드', '프론트'] }),
  row('3', '나', { st: '완료', tags: [], due: { start: '2026-09-03' } }),
  row('4', '라', { st: '보류', n: 3 }),
]
const ids = (list: CollectionRowData[]) => list.map((r) => r.id)

describe('applyView', () => {
  it('정렬은 앞의 것이 1순위이고, 빈 값은 방향과 상관없이 뒤로 간다', () => {
    const sorted = applyView(schema, rows, {
      sorts: [{ propId: 'n', direction: 'desc' }, { propId: 'title', direction: 'asc' }],
    })
    expect(ids(sorted)).toEqual(['2', '1', '4', '3']) // 10, 3(다), 3(라), 빈 값
    expect(ids(applyView(schema, rows, { sorts: [{ propId: 'n', direction: 'asc' }] }))).toEqual(['1', '4', '2', '3'])
  })

  it('필터 — 다중 선택의 is, 날짜의 비어 있음, 숫자 비교', () => {
    expect(ids(applyView(schema, rows, { filters: [{ propId: 'tags', op: 'is', value: '프론트' }] }))).toEqual(['2'])
    expect(ids(applyView(schema, rows, { filters: [{ propId: 'due', op: 'is_empty' }] }))).toEqual(['2', '4'])
    expect(ids(applyView(schema, rows, { filters: [{ propId: 'n', op: 'gte', value: 3 }] }))).toEqual(['1', '2', '4'])
    expect(ids(applyView(schema, rows, { filters: [{ propId: 'due', op: 'lt', value: '2026-09-05' }] }))).toEqual(['3'])
  })

  it('지워진 속성을 가리키는 필터·정렬은 건너뛴다', () => {
    expect(ids(applyView(schema, rows, {
      filters: [{ propId: 'gone', op: 'is', value: 'x' }],
      sorts: [{ propId: 'gone', direction: 'asc' }],
    }))).toEqual(['1', '2', '3', '4'])
  })
})

describe('groupRows', () => {
  it('옵션 순서대로, 행이 없는 옵션 칸도, 옵션에 없는 값은 그 뒤에, 미지정은 맨 끝', () => {
    const groups = groupRows(schema, rows, 'st')
    expect(groups.map((g) => [g.label, ids(g.rows)])).toEqual([
      ['할 일', ['2']],
      ['진행 중', []],
      ['완료', ['1', '3']],
      ['보류', ['4']],
      ['미지정', []],
    ])
  })

  it('다중 선택은 값마다 한 칸씩 — 두 태그를 가진 행은 두 칸에 나온다', () => {
    const groups = groupRows(schema, rows, 'tags')
    expect(groups.map((g) => [g.key, ids(g.rows)])).toEqual([
      ['백엔드', ['1', '2']],
      ['프론트', ['2']],
      ['', ['3', '4']],
    ])
  })
})
