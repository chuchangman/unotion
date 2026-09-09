/**
 * 페이지 보드 블록의 공용 정의.
 *
 * ★ 클라이언트와 서버가 **같은 타입 이름과 propSchema** 를 써야 한다.
 *   ydoc 은 ProseMirror 노드로 저장되므로, 서버(MCP get_page)가 이 블록을 모르면
 *   문서를 파싱할 때 블록이 사라지거나 변환이 깨진다.
 *
 * 스펙 자체는 각자 만들되(클라이언트는 React 렌더러 포함, 서버는 렌더러 없이),
 * 이름과 props 는 이 파일 하나에서 가져다 쓴다.
 * 이 파일에는 React 를 넣지 않는다 — 서버 라우트(react-server 레이어)에서
 * import 해야 하기 때문이다.
 */

export const PAGE_BOARD_TYPE = 'pageBoard' as const

/** 보드의 한 칸. 각 칸은 실제 하위 페이지 하나를 가리키고 그 자식들을 나열한다. */
export type BoardColumn = {
  /** 이 칸이 가리키는 페이지 id (이 페이지의 자식들이 목록이 된다) */
  pageId: string
  /** 칸 제목. 보통 그 페이지의 제목과 같지만 따로 둘 수 있다 */
  title: string
  /** 가로 비율 (%). 전체 합이 100 이 되도록 유지한다 */
  width: number
}

/** props 는 문자열만 담는다 — ProseMirror 속성은 원시값이어야 안전하다 */
export const pageBoardPropSchema = {
  columns: { default: '[]' as string },
}

export function parseColumns(raw: unknown): BoardColumn[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (c): c is BoardColumn =>
          c && typeof c.pageId === 'string' && typeof c.title === 'string',
      )
      .map((c) => ({ ...c, width: typeof c.width === 'number' ? c.width : 50 }))
  } catch {
    return []
  }
}

export function serializeColumns(cols: BoardColumn[]): string {
  return JSON.stringify(cols)
}

/** 칸을 추가하거나 지운 뒤 폭 합을 100 으로 맞춘다 */
export function normalizeWidths(cols: BoardColumn[]): BoardColumn[] {
  if (cols.length === 0) return cols
  const even = 100 / cols.length
  return cols.map((c) => ({ ...c, width: even }))
}
