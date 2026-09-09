/**
 * 서버용 BlockNote 스키마.
 *
 * 클라이언트가 pageBoard 블록을 문서에 넣으면 ydoc 안에 그 노드가 들어간다.
 * 서버가 같은 타입을 모른 채 파싱하면 그 블록을 잃어버리고,
 * MCP update_page 가 저장하는 순간 사용자의 보드가 사라진다.
 *
 * 그래서 **이름과 propSchema 가 같은** 스펙을 서버에도 등록한다.
 * 여기서는 React 를 쓰지 않는다 — 이 파일은 MCP 라우트(react-server 레이어)에서
 * 로드되므로 React 컴포넌트를 들이면 createContext 오류가 난다.
 * 렌더링은 필요 없고 파싱과 직렬화만 되면 된다.
 */
import { BlockNoteSchema, createBlockSpec, defaultBlockSpecs } from '@blocknote/core'
import { PAGE_BOARD_TYPE, pageBoardPropSchema, parseColumns } from '../page-board'

const serverPageBoard = createBlockSpec(
  {
    type: PAGE_BOARD_TYPE,
    propSchema: pageBoardPropSchema,
    content: 'none',
  },
  {
    render: () => {
      const dom = document.createElement('div')
      dom.setAttribute('data-page-board', '')
      return { dom }
    },
    /**
     * 마크다운으로 나갈 때의 모습.
     * 자식 목록은 DB 를 봐야 알 수 있어 여기서는 칸 제목과 링크만 남긴다.
     * 클로드가 MCP 로 문서를 읽을 때 "보드가 있고 이런 칸들이 있다" 는 사실이
     * 전달되면 충분하다. 실제 목록은 list_pages 로 본다.
     */
    toExternalHTML: (block) => {
      const dom = document.createElement('div')
      const cols = parseColumns(block.props.columns)
      if (cols.length === 0) {
        dom.textContent = '(빈 페이지 보드)'
        return { dom }
      }
      const ul = document.createElement('ul')
      for (const c of cols) {
        const li = document.createElement('li')
        const a = document.createElement('a')
        a.setAttribute('href', `/p/${c.pageId}`)
        a.textContent = c.title || '제목 없음'
        li.appendChild(a)
        ul.appendChild(li)
      }
      dom.appendChild(ul)
      return { dom }
    },
  },
)

/** 클라이언트(Editor.tsx)의 스키마와 블록 구성이 같아야 한다 */
export const serverSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, [PAGE_BOARD_TYPE]: serverPageBoard() },
})
