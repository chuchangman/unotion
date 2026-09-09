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

/**
 * 커스텀 스키마를 넘기면 ServerBlockNoteEditor 의 제네릭이 그 스키마로 좁혀진다.
 * 이 파일은 변환(마크다운 <-> 블록 <-> ydoc)만 하고 블록 타입을 직접 다루지 않으므로
 * 캐시는 느슨한 타입으로 들고 있는다.
 */
type Editor = Awaited<ReturnType<typeof makeEditor>>
let cached: Editor | null = null

async function makeEditor() {
  const { ServerBlockNoteEditor: E } = await import('@blocknote/server-util')
  const { serverSchema } = await import('./server-schema')
  return E.create({ schema: serverSchema })
}

/**
 * 지연 import 가 필수다.
 * 최상위에서 import 하면 Next 가 빌드 중 라우트 설정을 읽으려고 모듈을 평가하는데,
 * 그 시점의 react-server 조건에는 React.createContext 가 없어
 * "UA.createContext is not a function" 으로 빌드가 죽는다.
 * 생성 비용이 있으므로 한 번 만들고 요청 간 재사용한다.
 */
async function editor(): Promise<Editor> {
  // 클라이언트와 같은 스키마를 써야 커스텀 블록(pageBoard)이 유실되지 않는다
  cached ??= await makeEditor()
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

export class EditMatchError extends Error {
  constructor(message: string, readonly kind: 'not_found' | 'ambiguous') {
    super(message)
    this.name = 'EditMatchError'
  }
}

/**
 * 문서 일부만 고친다 (파일 편집 도구와 같은 방식).
 *
 * 전에는 replace 로 전체를 다시 쓰는 길밖에 없어서, 한 문단을 고치려 해도
 * 문서 전체를 재생성해야 했다. 토큰이 낭비되고 재생성 과정에서 손대지 않은
 * 부분까지 바뀔 위험이 있었다.
 *
 * 내부적으로는 여전히 마크다운 전체를 다시 파싱하지만, Yjs 가 diff 를 내므로
 * CRDT 상으로는 바뀐 블록만 갱신된다 (실측: 전체 948B 중 증분 236B).
 */
export async function editMarkdown(
  current: Buffer | Uint8Array | null,
  oldText: string,
  newText: string,
  replaceAll = false,
): Promise<{ markdown: string; count: number }> {
  const md = await ydocBytesToMarkdown(current)

  if (!oldText) throw new EditMatchError('찾을 텍스트가 비어 있습니다', 'not_found')

  const occurrences = md.split(oldText).length - 1
  if (occurrences === 0) {
    throw new EditMatchError(
      '문서에서 그 텍스트를 찾지 못했습니다. get_page 로 현재 본문을 다시 읽고, ' +
      '공백과 줄바꿈까지 그대로 복사해서 넘기세요.',
      'not_found',
    )
  }
  if (occurrences > 1 && !replaceAll) {
    throw new EditMatchError(
      `그 텍스트가 ${occurrences}군데 있습니다. 앞뒤 줄을 더 포함해 유일하게 만들거나, ` +
      'replace_all 을 켜세요.',
      'ambiguous',
    )
  }

  const markdown = replaceAll ? md.split(oldText).join(newText) : md.replace(oldText, newText)
  return { markdown, count: replaceAll ? occurrences : 1 }
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
