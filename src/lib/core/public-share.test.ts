import { beforeAll, describe, expect, it } from 'vitest'
import { parseFragment } from 'parse5'
import { applyBlocks, ydocBytesToHTML } from './markdown'
import { sanitizeHtml } from './public-share'

type Node = {
  tagName?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Node[]
  content?: Node
}

const BANNED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'link',
  'meta', 'form', 'template', 'noscript', 'noembed', 'noframes', 'textarea', 'title', 'xmp',
  'plaintext', 'svg', 'math',
])
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'data'])

const TAB = String.fromCharCode(9)
const LF = String.fromCharCode(10)
const SOH = String.fromCharCode(1)

/** 브라우저가 여는 스킴. WHATWG URL 파서가 탭·줄바꿈·앞쪽 제어 문자를 처리하는 방식 그대로다 */
function scriptUrl(value: string) {
  let url: URL
  try { url = new URL(value, 'https://wiki.example/') } catch { return false }
  if (url.protocol === 'javascript:' || url.protocol === 'vbscript:') return true
  return url.protocol === 'data:' && !url.href.startsWith('data:image/')
}

/**
 * 브라우저가 이 HTML 을 읽었을 때 남는 위험. 문자열이 아니라 **파싱 결과**를 본다 —
 * 우리가 태그로 읽은 곳과 브라우저가 태그로 읽는 곳이 다르면 문자열 검사는 속는다.
 */
function dangers(html: string): string[] {
  const found: string[] = []
  const visit = (node: Node) => {
    if (node.tagName) {
      if (BANNED.has(node.tagName)) found.push(`<${node.tagName}>`)
      for (const { name, value } of node.attrs ?? []) {
        if (name.startsWith('on') || name === 'srcdoc') found.push(`${node.tagName}[${name}]`)
        if (URL_ATTRS.has(name) && scriptUrl(value)) found.push(`${node.tagName}[${name}=${JSON.stringify(value)}]`)
      }
    }
    node.childNodes?.forEach(visit)
    if (node.content) visit(node.content)
  }
  visit(parseFragment(html) as unknown as Node)
  return found
}

const ATTACKS = [
  // 스킴 숨기기 — 브라우저는 줄바꿈·탭을 지우고, 문자 참조를 풀고, 앞의 제어 문자를 무시한다
  `<a href="java${LF}script:alert(1)">x</a>`,
  `<a href="java${TAB}script:alert(1)">x</a>`,
  `<a href="${SOH}javascript:alert(1)">x</a>`,
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;avascript&colon;alert(1)">x</a>',
  '<a href="java&Tab;script:alert(1)">x</a>',
  '<a href="java&#10;script:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  "<a HREF='JaVaScRiPt:alert(1)'>x</a>",
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<button formaction="javascript:alert(1)">x</button>',
  // 이벤트 속성 — 공백 대신 / 로 떼어 써도 속성이다
  '<img/onerror=alert(1) src=x>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" ONERROR="alert(1)">',
  '<p onclick="alert(1)" onmouseover=alert(1)>x</p>',
  '<a b"c=d onclick=alert(1)>x</a>',
  // 실행되는 태그
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel="stylesheet" href="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><button>x</button></form>',
  '<svg onload=alert(1)><a xlink:href="javascript:alert(1)">x</a></svg>',
  '<math><a href="javascript:alert(1)">x</a></math>',
  // 우리가 읽는 것과 브라우저가 읽는 것을 어긋나게 하려는 시도
  '<style><a title="</style><img src=x onerror=alert(1)>"></style>',
  '<title><a title="</title><img src=x onerror=alert(1)>"></title>',
  '<textarea><a title="</textarea><img src=x onerror=alert(1)>"></textarea>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<xmp><p title="</xmp><img src=x onerror=alert(1)>"></xmp>',
  '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<!-- --!><img src=x onerror=alert(1)> -->',
  '<p title=">"><img src=x onerror=alert(1)></p>',
  '</p onclick=alert(1)><img src=x onerror=alert(1)>',
]

/** 원문은 무해하지만, 조각을 지우고 이어 붙이는 거르개가 스스로 공격을 완성하게 만드는 입력 */
const EVASIONS = [
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x o<script></script>nerror=alert(1)>',
  '<a href="x" title="unclosed><img src=x onerror=alert(1)>',
  '<a href="java<!-- -->script:alert(1)">x</a>',
]

describe('sanitizeHtml', () => {
  /**
   * 서버 에디터(jsdom)는 처음 부를 때 만들어진다. 다른 테스트 파일과 동시에 돌면 그게
   * 기본 제한(5초)을 넘겨 첫 테스트만 가끔 실패했다 — 여기서 미리 띄워 둔다.
   */
  beforeAll(async () => {
    await applyBlocks(null, [{ type: 'paragraph', content: '준비' }])
  }, 60_000)

  it.each(ATTACKS)('%j — 거르지 않으면 브라우저 기준으로 위험하다', (html) => {
    // 전제를 확인해 둔다. 이게 빈 배열이면 아래 테스트는 아무것도 증명하지 않는다
    expect(dangers(html)).not.toEqual([])
  })

  it.each([...ATTACKS, ...EVASIONS])('%j — 거르면 브라우저가 읽어도 위험이 남지 않는다', (html) => {
    expect(dangers(sanitizeHtml(html))).toEqual([])
  })

  it('파일 블록 URL 의 줄바꿈 낀 javascript: — 에디터에서 실제로 만들 수 있는 경로', async () => {
    const { delta } = await applyBlocks(null, [
      { type: 'file', props: { url: `java${LF}script:alert(document.domain)`, name: '보고서.pdf' } },
    ])
    const html = await ydocBytesToHTML(delta)
    expect(dangers(html)).not.toEqual([]) // 직렬화기는 그대로 내보낸다
    const clean = sanitizeHtml(html)
    expect(dangers(clean)).toEqual([])
    expect(clean).toContain('href="#"')
    expect(clean).toContain('보고서.pdf')
  })

  it('평범한 문서는 한 글자도 바꾸지 않는다', async () => {
    const { delta } = await applyBlocks(null, [
      { type: 'heading', props: { level: 2 }, content: '회의록 <초안>' },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '코드: <button onClick={go}> online=yes & a<b ', styles: { bold: true } },
          { type: 'link', href: 'https://example.com/a?b=1&c=2', content: [{ type: 'text', text: '링크', styles: {} }] },
          { type: 'text', text: ' ', styles: {} },
          { type: 'link', href: 'mailto:team@example.com', content: [{ type: 'text', text: '메일', styles: {} }] },
          { type: 'text', text: ' ', styles: {} },
          { type: 'link', href: '/p/00000000-0000-4000-8000-000000000000', content: [{ type: 'text', text: '내부', styles: {} }] },
        ],
      },
      { type: 'bulletListItem', content: '하나' },
      { type: 'numberedListItem', content: '둘' },
      { type: 'checkListItem', props: { checked: true }, content: '셋' },
      { type: 'codeBlock', props: { language: 'ts' }, content: 'if (a < b && c > d) onLoad = () => {}' },
      { type: 'image', props: { url: 'https://cdn.example/x.png', caption: '그림' } },
      { type: 'file', props: { url: 'https://cdn.example/f.pdf', name: 'f.pdf' } },
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: ['이름', '역할'] }, { cells: ['김', 'onboarding=담당'] }],
        },
      },
    ])
    const html = await ydocBytesToHTML(delta)
    expect(html).toContain('onClick={go}') // 글자로 들어 있다
    expect(sanitizeHtml(html)).toBe(html)
  })

  it('data:image 는 이미지 src 에서만 허용한다', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    expect(sanitizeHtml(`<img src="${png}">`)).toBe(`<img src="${png}">`)
    expect(sanitizeHtml(`<a href="${png}">x</a>`)).toBe('<a href="#">x</a>')
  })

  it('태그가 못 된 < 는 글자로, 주석은 지운다', () => {
    expect(sanitizeHtml('<p>1 < 2</p>')).toBe('<p>1 &lt; 2</p>')
    expect(sanitizeHtml('<img src=x onerror=alert(1)')).toBe('&lt;img src=x onerror=alert(1)')
    expect(sanitizeHtml('<p>a<!-- <img src=x onerror=alert(1)> -->b</p>')).toBe('<p>ab</p>')
  })
})
