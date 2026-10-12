import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { serverSchema } from '@/lib/core/server-schema'
import { blocksToPlainText } from '@/lib/blocks'
import { serializeColumns } from '@/lib/page-board'
import {
  FRAGMENT, applyAndDetect, decodeFrame, deriveFromYDoc, docFromState, encodeFrame, hasStructsBeyond,
} from '@/lib/ydoc'

const PAGE_A = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const PAGE_B = '9e8d7c6b-5a49-4382-9716-f5e4d3c2b1a0'

const editor = ServerBlockNoteEditor.create({ schema: serverSchema })
const docOf = (blocks: unknown[]) => editor.blocksToYDoc(blocks as never, FRAGMENT)

/** 에디터가 실제로 만드는 모양들 — 표, 다단, 페이지 보드, 중첩, 링크가 섞여 있다 */
const SAMPLE = [
  { type: 'heading', props: { level: 2 }, content: '회의록' },
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: '배포는 ', styles: {} },
      { type: 'text', text: '화요일', styles: { bold: true } },
      { type: 'link', href: `/p/${PAGE_A}`, content: '📄 일정' },
    ],
  },
  { type: 'paragraph', content: '' },
  {
    type: 'bulletListItem',
    content: '할 일',
    children: [
      { type: 'bulletListItem', content: [{ type: 'link', href: `/p/${PAGE_B}`, content: '하위 문서' }] },
    ],
  },
  {
    type: 'table',
    content: { type: 'tableContent', rows: [{ cells: ['이름', '역할'] }, { cells: ['김', '개발'] }] },
  },
  {
    type: 'columnList',
    children: [
      { type: 'column', children: [{ type: 'paragraph', content: '왼쪽 칸' }] },
      { type: 'column', children: [{ type: 'paragraph', content: '오른쪽 칸' }] },
    ],
  },
  { type: 'pageBoard', props: { columns: serializeColumns([{ pageId: PAGE_A, title: '문서', width: 100 }]) } },
  { type: 'paragraph', content: [{ type: 'link', href: 'https://example.com', content: '외부 링크' }] },
]

describe('deriveFromYDoc', () => {
  it('블록 JSON 에서 뽑은 평문과 같다 (검색 입력이 저장 방식 때문에 달라지면 안 된다)', () => {
    const doc = docOf(SAMPLE)
    const blocks = editor.yDocToBlocks(doc, FRAGMENT)
    const derived = deriveFromYDoc(doc)

    expect(derived.plainText).toBe(blocksToPlainText(blocks))
    // 대조 기준이 비어 있어서 통과하는 게 아님을 확인한다
    expect(derived.plainText).toContain('왼쪽 칸')
    expect(derived.plainText).toContain('이름역할김개발')
  })

  it('우리 페이지를 가리키는 링크만 모은다 — 중첩 블록 안까지, 외부 링크는 빼고', () => {
    expect(deriveFromYDoc(docOf(SAMPLE)).links.sort()).toEqual([PAGE_A, PAGE_B].sort())
  })

  it('빈 문서는 빈 평문과 빈 링크', () => {
    expect(deriveFromYDoc(new Y.Doc())).toEqual({ plainText: '', links: [] })
  })
})

describe('applyAndDetect', () => {
  const typed = (text: string, base?: Uint8Array) => {
    const doc = docFromState(base)
    doc.getText('t').insert(doc.getText('t').length, text)
    return doc
  }

  it('이미 가진 내용을 다시 받으면 변화 없음 — 열기만 한 저장이 DB 를 건드리지 않는 근거', () => {
    const state = Y.encodeStateAsUpdate(typed('안녕'))
    expect(applyAndDetect(docFromState(state), state)).toBe(false)
  })

  it('새 편집은 변화다', () => {
    const base = Y.encodeStateAsUpdate(typed('안녕'))
    const next = Y.encodeStateAsUpdate(typed(' 여러분', base))
    expect(applyAndDetect(docFromState(base), next)).toBe(true)
  })

  it('삭제만 한 업데이트도 변화다 (상태벡터가 안 바뀌는 경우)', () => {
    const base = Y.encodeStateAsUpdate(typed('안녕하세요'))
    const doc = docFromState(base)
    doc.getText('t').delete(0, 2)
    expect(applyAndDetect(docFromState(base), Y.encodeStateAsUpdate(doc))).toBe(true)
  })

  it('의존 대상이 아직 없는 조각(보류)도 버리지 않는다', () => {
    const a = typed('하나')
    const base = Y.encodeStateAsUpdate(a)
    const sv = Y.encodeStateVector(a)
    a.getText('t').insert(2, '둘')
    const middle = Y.encodeStateAsUpdate(a, sv)
    const sv2 = Y.encodeStateVector(a)
    a.getText('t').insert(3, '셋')
    const tail = Y.encodeStateAsUpdate(a, sv2) // middle 없이는 붙을 자리가 없다

    const server = docFromState(base)
    expect(applyAndDetect(server, tail)).toBe(true)
    expect(server.getText('t').toString()).toBe('하나')
    applyAndDetect(server, middle)
    expect(server.getText('t').toString()).toBe('하나둘셋')
  })

  it('회귀: 열어 둔 탭의 저장이 MCP 가 쓴 내용을 지우지 않는다', () => {
    const s0 = Y.encodeStateAsUpdate(typed('회의록'))
    const browser = docFromState(s0)
    const mcp = docFromState(s0)
    mcp.getText('t').insert(3, ' + 클로드가 붙인 요약')

    const server = docFromState(Y.encodeStateAsUpdate(mcp)) // MCP 저장
    browser.getText('t').insert(0, '[수정] ')
    applyAndDetect(server, Y.encodeStateAsUpdate(browser)) // 브라우저 저장 — 예전엔 덮어썼다

    expect(server.getText('t').toString()).toBe('[수정] 회의록 + 클로드가 붙인 요약')
  })
})

describe('hasStructsBeyond', () => {
  it('서버가 모르는 편집이 있으면 true', () => {
    const doc = new Y.Doc()
    doc.getText('t').insert(0, '가')
    const server = Y.encodeStateVector(doc)
    expect(hasStructsBeyond(Y.encodeStateVector(doc), server)).toBe(false)
    doc.getText('t').insert(1, '나')
    expect(hasStructsBeyond(Y.encodeStateVector(doc), server)).toBe(true)
  })
})

describe('encodeFrame / decodeFrame', () => {
  it('상태벡터와 업데이트를 그대로 되돌린다', () => {
    const sv = new Uint8Array([1, 2, 3])
    const update = new Uint8Array([9, 8, 7, 6])
    expect(decodeFrame(encodeFrame(sv, update))).toEqual({ stateVector: sv, update })
    expect(decodeFrame(encodeFrame(sv, null))).toEqual({ stateVector: sv, update: null })
  })

  it('잘린 프레임은 거부한다', () => {
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 9, 1]))).toThrow()
  })
})
