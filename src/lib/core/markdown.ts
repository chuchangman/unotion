/**
 * 마크다운 <-> BlockNote <-> Yjs 변환.
 *
 * MCP 와 (나중에) 내보내기 기능이 공유한다. 서버 전용이다.
 *
 * ★ 왜 ydoc 까지 건드리나:
 *   ydoc 이 본문의 진실이고 content_json 은 파생 스냅샷이다.
 *   MCP 가 content_json 만 바꾸면 웹 에디터가 다음 저장 때 자기 ydoc 으로
 *   덮어써서 변경이 사라진다. 그래서 반드시 ydoc 을 갱신해야 한다.
 */
import 'server-only'
import * as Y from 'yjs'
import type { ServerBlockNoteEditor } from '@blocknote/server-util'

/** Editor.tsx 의 doc.getXmlFragment('blocknote') 와 반드시 같아야 한다 */
export const FRAGMENT = 'blocknote'

type Editor = ReturnType<typeof ServerBlockNoteEditor.create>
let cached: Editor | null = null

/**
 * 지연 import 가 필수다.
 * 최상위에서 import 하면 Next 가 빌드 중 라우트 설정을 읽으려고 모듈을 평가하는데,
 * 그 시점의 react-server 조건에는 React.createContext 가 없어
 * "UA.createContext is not a function" 으로 빌드가 죽는다.
 * 생성 비용이 있으므로 한 번 만들고 요청 간 재사용한다.
 */
async function editor(): Promise<Editor> {
  if (!cached) {
    const { ServerBlockNoteEditor: E } = await import('@blocknote/server-util')
    cached = E.create()
  }
  return cached
}

export type WriteMode = 'replace' | 'append' | 'prepend'

export async function markdownToBlocks(markdown: string) {
  return (await editor()).tryParseMarkdownToBlocks(markdown)
}

export async function blocksToMarkdown(blocks: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await editor()).blocksToMarkdownLossy(blocks as any)
}

export async function ydocBytesToBlocks(bytes: Buffer | Uint8Array | null) {
  if (!bytes || bytes.byteLength === 0) return []
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(bytes))
  return (await editor()).yDocToBlocks(doc, FRAGMENT)
}

/** 저장된 ydoc 을 마크다운으로. 없으면 빈 문자열. */
export async function ydocBytesToMarkdown(bytes: Buffer | Uint8Array | null) {
  const blocks = await ydocBytesToBlocks(bytes)
  return blocks.length ? blocksToMarkdown(blocks) : ''
}

export type ApplyResult = {
  /** 저장할 전체 ydoc 상태 */
  ydoc: Buffer
  /** 파생 스냅샷 */
  blocks: unknown
  /** 열려 있는 클라이언트에게 브로드캐스트할 증분 */
  delta: Uint8Array
}

/**
 * 기존 ydoc 에 마크다운을 적용한다.
 *
 * 주의: blocksToYXmlFragment 는 프래그먼트를 **교체**한다 (이어붙이지 않는다).
 * 그래서 append/prepend 는 기존 블록을 읽어 합친 뒤 통째로 다시 쓴다.
 * 결과적으로 이 연산은 문서 전체를 갈아끼우는 굵은 CRDT 변경이라,
 * 같은 시점에 사람이 편집 중이었다면 MCP 쪽이 이긴다. 의도된 트레이드오프다.
 */
export async function applyMarkdown(
  current: Buffer | Uint8Array | null,
  markdown: string,
  mode: WriteMode,
): Promise<ApplyResult> {
  const ed = await editor()
  const doc = new Y.Doc()
  if (current && current.byteLength > 0) {
    Y.applyUpdate(doc, new Uint8Array(current))
  }

  // 변경 전 상태벡터 — 이걸 기준으로 증분을 뽑는다
  const beforeSV = Y.encodeStateVector(doc)

  const incoming = await ed.tryParseMarkdownToBlocks(markdown)
  const existing = ed.yDocToBlocks(doc, FRAGMENT)

  const next =
    mode === 'append' ? [...existing, ...incoming]
    : mode === 'prepend' ? [...incoming, ...existing]
    : incoming

  ed.blocksToYXmlFragment(next, doc.getXmlFragment(FRAGMENT))

  return {
    ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)),
    blocks: ed.yDocToBlocks(doc, FRAGMENT),
    delta: Y.encodeStateAsUpdate(doc, beforeSV),
  }
}
