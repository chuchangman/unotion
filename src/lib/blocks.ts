/**
 * BlockNote 문서 <-> 평문 변환.
 * 검색/RAG/MCP 가 모두 쓰므로 클라이언트/서버 양쪽에서 임포트 가능해야 한다
 * (그래서 'use client' 도, DB 임포트도 없다).
 */

type BlockLike = { type?: string; content?: unknown; children?: unknown }

/**
 * 한 블록의 텍스트.
 *
 * 형태를 가정하지 않고 깊이 훑는다. content 가 배열인 경우만 보면 **표를 통째로
 * 놓친다** — 표의 content 는 배열이 아니라 { type: 'tableContent', rows: [...] }
 * 객체다. 그러면 표 안에 쓴 내용이 plain_text 에 안 들어가고,
 * 검색(pg_trgm 인덱스의 입력이 plain_text 다)에서 영영 안 잡힌다.
 */
function inlineText(content: unknown): string {
  if (typeof content === 'string') return content

  const parts: string[] = []
  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 20) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return

    const obj = node as Record<string, unknown>
    if (typeof obj.text === 'string') parts.push(obj.text)
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') walk(value, depth + 1)
    }
  }

  walk(content, 0)
  return parts.join('')
}

/** 블록 트리를 줄바꿈으로 이어붙인 평문. 검색 인덱스의 입력이다. */
export function blocksToPlainText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const lines: string[] = []

  const walk = (list: unknown[]) => {
    for (const raw of list) {
      const b = raw as BlockLike
      const text = inlineText(b?.content)
      if (text.trim()) lines.push(text)
      if (Array.isArray(b?.children)) walk(b.children as unknown[])
    }
  }

  walk(blocks)
  return lines.join('\n')
}

const PAGE_HREF = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * 본문이 가리키는 페이지 id 들. 백링크의 입력이다.
 *
 * 에디터는 페이지 링크를 **기본 link 마크**로 넣는다(`[📄 제목](/p/<id>)`).
 * 그래서 커스텀 노드를 찾을 필요 없이 href 만 보면 된다.
 *
 * 클라이언트에서 뽑아 저장 요청에 실어 보낸다 — 서버에서 ydoc 을 다시 파싱하면
 * 자동저장마다(2초) 문서 전체를 블록으로 푸는 비용이 붙는다.
 */
export function blocksToPageLinks(blocks: unknown): string[] {
  const found = new Set<string>()

  /**
   * 블록 트리를 **깊이 그대로** 훑는다.
   *
   * content 가 배열인 일반 블록만 보면 표 안의 링크를 통째로 놓친다 —
   * 표는 content 가 배열이 아니라 { type: 'tableContent', rows: [{ cells: [...] }] }
   * 객체다. 앞으로 블록 종류가 늘어도 안 깨지도록 형태를 가정하지 않고 훑는다.
   */
  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 20) return

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return

    const obj = node as Record<string, unknown>
    if (typeof obj.href === 'string') {
      const m = PAGE_HREF.exec(obj.href)
      if (m) found.add(m[1].toLowerCase())
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') walk(value, depth + 1)
    }
  }

  walk(blocks, 0)
  return [...found]
}

/** 본문 첫 줄에서 제목 후보를 뽑는다 (제목이 비었을 때만 사용) */
export function inferTitle(blocks: unknown): string {
  const text = blocksToPlainText(blocks)
  const first = text.split('\n').find((l) => l.trim())
  return (first ?? '').slice(0, 120)
}
