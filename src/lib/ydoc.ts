/**
 * Yjs 문서 유틸. 클라이언트와 서버가 같이 쓴다 (그래서 DB 도, BlockNote 도 모른다).
 *
 *   - FRAGMENT        에디터와 서버 변환기가 합의한 프래그먼트 이름
 *   - deriveFromYDoc  검색용 평문과 백링크를 **ydoc 에서 직접** 뽑는다
 *   - applyAndDetect  들어온 업데이트가 실제로 무언가를 더했는지
 *   - encodeFrame     상태벡터 + 업데이트를 한 바이너리 응답에 싣는다
 *
 * ★ 왜 서버가 ydoc 에서 직접 뽑나
 *   저장이 "덮어쓰기"에서 "병합"으로 바뀌었다(lib/core/page-content.ts 의 applyYdocUpdate).
 *   병합 결과에는 저장을 보낸 클라이언트가 모르는 내용(MCP 가 쓴 문단, 다른 사람의
 *   편집)이 섞여 있을 수 있어서, 클라이언트가 계산해 보낸 평문은 더 이상 맞지 않는다.
 *
 * ★ BlockNote·jsdom 을 쓰지 않는다
 *   저장은 3초마다 도는 경로다. 여기서 서버용 BlockNote 에디터를 띄우면 저장 한 번이
 *   수백 ms 가 된다. y-prosemirror 가 만든 XML 트리를 그대로 훑으면 충분하다.
 *   결과는 lib/blocks.ts 의 blocksToPlainText 와 같아야 한다 (ydoc.test.ts 가 대조한다).
 */
import * as Y from 'yjs'
import { pageIdFromHref } from './blocks'

/** Editor 의 doc.getXmlFragment(...) 와 서버 변환기(lib/core/markdown.ts)가 이 이름을 쓴다 */
export const FRAGMENT = 'blocknote'

export type Derived = {
  /** 블록 하나가 한 줄. 빈 블록은 뺀다 — blocksToPlainText 와 같은 규칙 */
  plainText: string
  /** 본문이 가리키는 페이지 id (백링크의 입력) */
  links: string[]
}

/**
 * 블록을 **담기만 하는** 노드. 안으로 들어가 blockContainer 를 찾는다.
 * columnList/column 은 다단(@blocknote/xl-multi-column)이 만든다.
 */
const CONTAINERS = new Set(['blockGroup', 'columnList', 'column'])

/** 줄바꿈 인라인 노드. 블록 JSON 에서는 텍스트 속 '\n' 으로 나온다 */
const HARD_BREAK = 'hardBreak'

export function deriveFromYDoc(doc: Y.Doc): Derived {
  const lines: string[] = []
  const links = new Set<string>()

  const visit = (parent: Y.XmlFragment | Y.XmlElement, depth: number) => {
    if (depth > 60) return
    for (const node of parent.toArray()) {
      if (!(node instanceof Y.XmlElement)) continue
      if (node.nodeName !== 'blockContainer') {
        visit(node, depth + 1)
        continue
      }
      // blockContainer = [내용 노드, (자식 blockGroup)] — 내용이 먼저 오므로 순서가 블록 JSON 과 같다
      for (const part of node.toArray()) {
        if (!(part instanceof Y.XmlElement)) continue
        if (CONTAINERS.has(part.nodeName)) {
          visit(part, depth + 1)
        } else {
          const text = textOf(part, links, 0)
          if (text.trim()) lines.push(text)
        }
      }
    }
  }

  visit(doc.getXmlFragment(FRAGMENT), 0)
  return { plainText: lines.join('\n'), links: [...links] }
}

/**
 * 내용 노드 하나의 글자. 표처럼 안쪽에 칸이 여럿이어도 한 줄로 잇는다
 * (blocksToPlainText 가 표를 그렇게 다룬다 — 검색 입력이 갈라지지 않게 맞춘다).
 */
function textOf(node: Y.XmlElement, links: Set<string>, depth: number): string {
  if (depth > 30) return ''
  let out = ''
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
        if (typeof op.insert === 'string') out += op.insert
        collectLinks(op.attributes, links)
      }
    } else if (child instanceof Y.XmlElement) {
      out += child.nodeName === HARD_BREAK ? '\n' : textOf(child, links, depth + 1)
    }
  }
  return out
}

/**
 * 링크 마크는 y-prosemirror 가 서식 속성으로 담는다: { link: { href } }.
 * 겹칠 수 있는 마크는 'link--<해시>' 처럼 이름 뒤에 해시가 붙으므로 접두어로 본다.
 */
function collectLinks(attributes: Record<string, unknown> | undefined, links: Set<string>) {
  if (!attributes) return
  for (const [key, value] of Object.entries(attributes)) {
    if (key !== 'link' && !key.startsWith('link--')) continue
    const href = (value as { href?: unknown } | null)?.href
    if (typeof href !== 'string') continue
    const id = pageIdFromHref(href)
    if (id) links.add(id)
  }
}

// ─────────────────────────────────────────── 병합

/** 저장된 상태로 문서를 만든다. 없으면 빈 문서 */
export function docFromState(state: Uint8Array | null | undefined): Y.Doc {
  const doc = new Y.Doc()
  if (state && state.byteLength > 0) Y.applyUpdate(doc, state)
  return doc
}

/** 의존 대상이 아직 없어 보류된 구조체의 크기. 0 이면 보류가 없다 */
function pendingSize(doc: Y.Doc): number {
  return (doc.store.pendingStructs?.update.byteLength ?? 0) + (doc.store.pendingDs?.byteLength ?? 0)
}

/**
 * 업데이트를 적용하고, **새로 더해진 게 있었는지** 돌려준다.
 *
 * Yjs 는 새 구조체나 새 삭제가 있을 때만 'update' 를 낸다 — 이미 가진 내용을 다시
 * 받으면 조용하다. 그래서 문서를 열기만 한 클라이언트의 저장이 들어와도 DB 를
 * 건드리지 않고 끝낼 수 있다 (예전에는 열기만 해도 수정자·수정 시각이 바뀌었다).
 *
 * 의존 대상이 없어 보류(pending)된 조각도 "더해진 것" 으로 친다. 버리면 나중에
 * 그 대상이 도착해도 합칠 게 없다.
 */
export function applyAndDetect(doc: Y.Doc, update: Uint8Array, origin?: unknown): boolean {
  let changed = false
  const mark = () => { changed = true }
  const pendingBefore = pendingSize(doc)
  doc.on('update', mark)
  try {
    Y.applyUpdate(doc, update, origin)
  } finally {
    doc.off('update', mark)
  }
  return changed || pendingSize(doc) !== pendingBefore
}

/**
 * local 이 server 가 모르는 구조체를 들고 있는지 (상태벡터 비교).
 *
 * 삭제만 한 경우는 상태벡터가 안 바뀌므로 여기서 안 잡힌다. 그 삭제는 다음 편집의
 * 저장에 같이 실린다 — 저장은 항상 삭제 집합 전체를 싣는다.
 */
export function hasStructsBeyond(local: Uint8Array, server: Uint8Array): boolean {
  const theirs = Y.decodeStateVector(server)
  for (const [client, clock] of Y.decodeStateVector(local)) {
    if (clock > (theirs.get(client) ?? 0)) return true
  }
  return false
}

// ─────────────────────────────────────────── 전송 프레임

/**
 * [상태벡터 길이: 4바이트 big-endian][상태벡터][업데이트]
 *
 * 상태벡터를 헤더에 싣지 않는 이유: 편집 세션마다 clientID 가 새로 생겨서 오래된
 * 문서의 상태벡터는 수 KB 까지 자란다. 헤더 한도(보통 8KB)에 닿을 수 있다.
 */
export function encodeFrame(stateVector: Uint8Array, update: Uint8Array | null): Uint8Array {
  const body = update ?? new Uint8Array(0)
  const out = new Uint8Array(4 + stateVector.byteLength + body.byteLength)
  new DataView(out.buffer).setUint32(0, stateVector.byteLength)
  out.set(stateVector, 4)
  out.set(body, 4 + stateVector.byteLength)
  return out
}

export function decodeFrame(bytes: Uint8Array): { stateVector: Uint8Array; update: Uint8Array | null } {
  if (bytes.byteLength < 4) throw new Error('ydoc 프레임이 너무 짧습니다')
  const svLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (4 + svLength > bytes.byteLength) throw new Error('ydoc 프레임의 길이 정보가 잘못됐습니다')
  const stateVector = bytes.slice(4, 4 + svLength)
  const update = bytes.slice(4 + svLength)
  return { stateVector, update: update.byteLength > 0 ? update : null }
}
