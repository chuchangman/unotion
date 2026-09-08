/**
 * BlockNote 문서 <-> 평문 변환.
 * 검색/RAG/MCP 가 모두 쓰므로 클라이언트/서버 양쪽에서 임포트 가능해야 한다
 * (그래서 'use client' 도, DB 임포트도 없다).
 */

type InlineLike = { type?: string; text?: string; content?: unknown }
type BlockLike = { type?: string; content?: unknown; children?: unknown }

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((node) => {
      const n = node as InlineLike
      if (typeof n?.text === 'string') return n.text
      if (n?.content) return inlineText(n.content)
      return ''
    })
    .join('')
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

/** 본문 첫 줄에서 제목 후보를 뽑는다 (제목이 비었을 때만 사용) */
export function inferTitle(blocks: unknown): string {
  const text = blocksToPlainText(blocks)
  const first = text.split('\n').find((l) => l.trim())
  return (first ?? '').slice(0, 120)
}
