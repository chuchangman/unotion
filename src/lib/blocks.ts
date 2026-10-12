/**
 * BlockNote 문서(블록 JSON) -> 평문 변환.
 *
 * 저장되는 검색용 평문은 이제 서버가 ydoc 에서 직접 뽑는다(lib/ydoc.ts).
 * 이 파일은 에디터가 들고 있는 블록에서 바로 글이 필요할 때(회의 요약의 전문)와,
 * 그 서버 추출이 같은 결과를 내는지 대조하는 기준(ydoc.test.ts)으로 남는다.
 * 클라이언트/서버 양쪽에서 임포트하므로 'use client' 도, DB 임포트도 없다.
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
 * 링크 주소가 우리 페이지(`/p/<id>`)를 가리키면 그 id. 아니면 null.
 *
 * 에디터는 페이지 링크를 **기본 link 마크**로 넣는다(`[📄 제목](/p/<id>)`).
 * 그래서 커스텀 노드를 찾을 필요 없이 href 만 보면 된다. 백링크는 서버가 저장할 때
 * ydoc 에서 이걸로 뽑는다 (lib/ydoc.ts 의 deriveFromYDoc).
 */
export function pageIdFromHref(href: string): string | null {
  const m = PAGE_HREF.exec(href)
  return m ? m[1].toLowerCase() : null
}
