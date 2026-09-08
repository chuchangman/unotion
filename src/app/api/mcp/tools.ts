/**
 * MCP 툴 정의.
 *
 * 설계 원칙:
 *  1) 툴은 적고 크게. 40개를 노출하면 컨텍스트가 오염되고 모델이 헤맨다.
 *  2) 응답은 JSON 이 아니라 **마크다운**. JSON 은 토큰을 2~3배 먹고 모델이 더 못 읽는다.
 *  3) 응답에 길이 상한. 큰 페이지 하나가 컨텍스트를 날린다.
 *  4) 로직은 여기 두지 않는다. lib/core 를 호출만 한다 — 웹 UI 와 동일한 권한 게이트.
 */
import 'server-only'
import { z } from 'zod'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { mcpActor, type Actor } from '@/lib/core/actor'
import { DomainError } from '@/lib/core/errors'
import * as Pages from '@/lib/core/pages'
import * as Workspaces from '@/lib/core/workspaces'
import * as Md from '@/lib/core/markdown'

/** 한 응답이 넘지 말아야 할 대략적 문자수 (약 6k 토큰) */
const MAX_CHARS = 24_000

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function actorFrom(ctx: ServerContext): Actor {
  // authInfo 는 HTTP 전송에서만 존재하므로 ctx.http 아래에 있다
  const userId = ctx.http?.authInfo?.extra?.userId
  if (typeof userId !== 'string') {
    throw new DomainError('인증 정보가 없습니다', 'unauthorized')
  }
  return mcpActor(userId)
}

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] })
const fail = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }], isError: true })

function clip(s: string, limit = MAX_CHARS) {
  if (s.length <= limit) return s
  return `${s.slice(0, limit)}\n\n---\n_...생략됨 (${s.length.toLocaleString()}자 중 ${limit.toLocaleString()}자)._`
}

/** 사용자의 기본 워크스페이스 (팀이 하나인 전제) */
async function workspaceOf(actor: Actor) {
  const list = await Workspaces.getMyWorkspaces(actor.userId)
  if (!list.length) throw new DomainError('참여한 워크스페이스가 없습니다', 'not_found')
  return list[0]
}

const siteUrl = () => process.env.NEXT_PUBLIC_SITE_URL ?? ''
const pageUrl = (id: string) => (siteUrl() ? `${siteUrl()}/p/${id}` : `/p/${id}`)

/** 도메인 에러를 읽을 수 있는 툴 응답으로 바꾼다 */
function wrap<A>(fn: (args: A, actor: Actor) => Promise<ToolResult>) {
  return async (args: A, ctx: ServerContext): Promise<ToolResult> => {
    try {
      return await fn(args, actorFrom(ctx))
    } catch (err) {
      if (err instanceof DomainError) return fail(`${err.code}: ${err.message}`)
      console.error('[mcp] 처리 실패', err)
      return fail('서버 오류가 발생했습니다.')
    }
  }
}

export function registerTools(server: McpServer) {
  // ─────────────────────────────────────── 읽기

  server.registerTool(
    'search_pages',
    {
      title: '페이지 검색',
      description:
        '팀 위키에서 페이지를 검색한다. 제목과 본문을 부분일치로 찾으므로 한국어도 잘 동작한다 ' +
        '("회의"로 "회의록"이 찾아진다). 본문 전체가 아니라 제목과 발췌만 돌려주므로, ' +
        '내용이 필요하면 결과의 page_id 로 get_page 를 호출할 것.\n' +
        '예: query="온보딩", query="배포 절차"',
      inputSchema: {
        query: z.string().min(1).describe('검색어. 한국어 부분일치 가능'),
        limit: z.number().int().min(1).max(50).optional().describe('최대 결과 수 (기본 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ query, limit }, actor) => {
      const ws = await workspaceOf(actor)
      const hits = await Pages.searchPages(actor, ws.id, query, limit ?? 10)
      if (!hits.length) return text(`"${query}" 에 해당하는 페이지가 없습니다.`)

      const body = hits
        .map((h) => `- **${h.title}** — \`${h.id}\`\n  ${h.snippet.replace(/\s+/g, ' ').trim()}`)
        .join('\n')
      return text(`"${query}" 검색 결과 ${hits.length}건:\n\n${clip(body)}`)
    }),
  )

  server.registerTool(
    'get_page',
    {
      title: '페이지 읽기',
      description:
        '페이지 하나를 마크다운으로 읽는다. page_id 는 search_pages 나 list_pages 로 얻는다. ' +
        '본문이 매우 길면 뒤가 생략된다.',
      inputSchema: {
        page_id: z.string().uuid().describe('페이지 UUID'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ page_id }, actor) => {
      const page = await Pages.getPage(actor, page_id)
      const md = await Md.ydocBytesToMarkdown(page.ydoc)
      const head = [
        `# ${page.title || '제목 없음'}`,
        '',
        `_${pageUrl(page.id)} · 최종수정 ${page.updatedAt.toISOString()}_`,
        '',
        '---',
        '',
      ].join('\n')
      return text(clip(head + (md || '_(본문이 비어 있습니다)_')))
    }),
  )

  server.registerTool(
    'list_pages',
    {
      title: '페이지 목록',
      description:
        '워크스페이스의 페이지 트리를 계층 그대로 돌려준다. 위키 전체 구조를 파악하거나 ' +
        '새 페이지를 어디에 만들지 정할 때 먼저 호출할 것.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async (_args, actor) => {
      const ws = await workspaceOf(actor)
      const nodes = await Pages.getPageTree(actor, ws.id)
      if (!nodes.length) return text('페이지가 없습니다.')

      const byParent = new Map<string | null, typeof nodes>()
      for (const n of nodes) {
        const list = byParent.get(n.parentId)
        if (list) list.push(n)
        else byParent.set(n.parentId, [n])
      }

      const lines: string[] = []
      const walk = (parentId: string | null, depth: number) => {
        for (const n of byParent.get(parentId) ?? []) {
          const icon = n.icon?.type === 'emoji' ? `${n.icon.value} ` : ''
          lines.push(`${'  '.repeat(depth)}- ${icon}${n.title || '제목 없음'} — \`${n.id}\``)
          if (depth < 10) walk(n.id, depth + 1)
        }
      }
      walk(null, 0)

      return text(`**${ws.name}** 페이지 ${nodes.length}개:\n\n${clip(lines.join('\n'))}`)
    }),
  )

  server.registerTool(
    'get_recent_changes',
    {
      title: '최근 변경',
      description:
        '최근에 수정된 페이지를 최신순으로 돌려준다. "이번 주에 뭐 바뀌었어?" 같은 질문에 쓴다.',
      inputSchema: {
        since_hours: z.number().int().min(1).max(2160).optional()
          .describe('몇 시간 전까지 볼지 (기본 168 = 1주)'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ since_hours }, actor) => {
      const ws = await workspaceOf(actor)
      const hours = since_hours ?? 168
      const since = new Date(Date.now() - hours * 3600_000)
      const rows = await Pages.getRecentChanges(actor, ws.id, since)
      if (!rows.length) return text(`최근 ${hours}시간 동안 변경된 페이지가 없습니다.`)

      const body = rows
        .map((r) => `- **${r.title || '제목 없음'}** — \`${r.id}\` · ${r.updatedAt.toISOString()}`)
        .join('\n')
      return text(`최근 ${hours}시간 변경 ${rows.length}건:\n\n${clip(body)}`)
    }),
  )

  server.registerTool(
    'list_members',
    {
      title: '팀 멤버 목록',
      description: '워크스페이스 멤버를 돌려준다. 담당자 지정이나 멘션 대상을 찾을 때 쓴다.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async (_args, actor) => {
      const ws = await workspaceOf(actor)
      const members = await Workspaces.listMembers(actor, ws.id)
      const body = members
        .map((m) => `- ${m.displayName} (${m.email}) — ${m.role} · \`${m.id}\``)
        .join('\n')
      return text(`**${ws.name}** 멤버 ${members.length}명:\n\n${body}`)
    }),
  )

  // ─────────────────────────────────────── 쓰기

  server.registerTool(
    'create_page',
    {
      title: '페이지 생성',
      description:
        '새 페이지를 만든다. 본문은 마크다운으로 넘긴다 (제목·목록·코드블록·굵게 등 지원). ' +
        'parent_id 를 주면 그 페이지의 하위로, 생략하면 최상위에 만든다. ' +
        '어디에 만들지 모르면 먼저 list_pages 로 구조를 볼 것.',
      inputSchema: {
        title: z.string().min(1).describe('페이지 제목'),
        markdown: z.string().optional().describe('본문 마크다운. 생략하면 빈 페이지'),
        parent_id: z.string().uuid().optional().describe('상위 페이지 UUID'),
      },
      annotations: { readOnlyHint: false },
    },
    wrap(async ({ title, markdown, parent_id }, actor) => {
      const ws = await workspaceOf(actor)
      const page = await Pages.createPage(actor, {
        workspaceId: ws.id,
        parentId: parent_id ?? null,
        title,
      })

      if (markdown?.trim()) {
        const applied = await Md.applyMarkdown(null, markdown, 'replace')
        await Pages.savePageContent(actor, page.id, {
          ydoc: applied.ydoc,
          contentJson: applied.blocks,
          plainText: await Md.blocksToMarkdown(applied.blocks),
          title,
        })
      }

      return text(
        `페이지를 만들었습니다.\n\n- 제목: **${title}**\n- ID: \`${page.id}\`\n- 링크: ${pageUrl(page.id)}`,
      )
    }),
  )

  server.registerTool(
    'update_page',
    {
      title: '페이지 수정',
      description:
        '페이지 본문을 마크다운으로 수정한다.\n' +
        '- mode="append" (기본): 기존 내용 뒤에 덧붙인다. 회의록 추가 등 가장 안전하고 자주 쓰인다.\n' +
        '- mode="prepend": 앞에 붙인다.\n' +
        '- mode="replace": 본문 전체를 갈아끼운다. 되돌릴 수 없으니 사용자가 명확히 요청했을 때만.\n' +
        '누군가 그 페이지를 브라우저에서 열어둔 상태라면 새로고침해야 보인다.',
      inputSchema: {
        page_id: z.string().uuid().describe('페이지 UUID'),
        markdown: z.string().min(1).describe('추가하거나 교체할 마크다운'),
        mode: z.enum(['append', 'prepend', 'replace']).optional().describe('기본 append'),
        title: z.string().optional().describe('제목도 함께 바꿀 때만'),
      },
      annotations: { readOnlyHint: false },
    },
    wrap(async ({ page_id, markdown, mode, title }, actor) => {
      const page = await Pages.getPage(actor, page_id)
      const writeMode = mode ?? 'append'

      const applied = await Md.applyMarkdown(page.ydoc, markdown, writeMode)
      await Pages.savePageContent(actor, page_id, {
        ydoc: applied.ydoc,
        contentJson: applied.blocks,
        plainText: await Md.blocksToMarkdown(applied.blocks),
        title: title ?? page.title,
      })

      return text(
        `**${(title ?? page.title) || '제목 없음'}** 을 수정했습니다 (mode=${writeMode}).\n\n` +
        `링크: ${pageUrl(page_id)}`,
      )
    }),
  )

  server.registerTool(
    'trash_page',
    {
      title: '페이지 휴지통으로',
      description:
        '페이지를 휴지통으로 보낸다. 하위 페이지도 함께 이동한다. ' +
        '완전 삭제가 아니라 앱에서 복원할 수 있다. 사용자가 명확히 요청했을 때만 쓸 것.',
      inputSchema: {
        page_id: z.string().uuid().describe('페이지 UUID'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    wrap(async ({ page_id }, actor) => {
      const page = await Pages.getPage(actor, page_id)
      await Pages.trashPage(actor, page_id)
      return text(
        `**${page.title || '제목 없음'}** 을 휴지통으로 보냈습니다 (하위 페이지 포함). 앱에서 복원할 수 있습니다.`,
      )
    }),
  )
}

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'weekly-report',
    {
      title: '주간 보고 초안',
      description: '최근 1주 변경사항을 모아 주간 보고 초안을 만든다',
      argsSchema: { focus: z.string().optional() },
    },
    ({ focus }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            'get_recent_changes(since_hours=168) 로 지난 1주 변경사항을 가져오고, ' +
            '중요해 보이는 페이지는 get_page 로 내용을 확인해서 주간 보고 초안을 작성해줘. ' +
            '완료된 것 / 진행 중 / 다음 주 계획으로 나누고, 각 항목에 페이지 링크를 달아줘.' +
            (focus ? `\n\n특히 이 주제에 집중해줘: ${focus}` : ''),
        },
      }],
    }),
  )

  server.registerPrompt(
    'meeting-notes',
    {
      title: '회의록 정리',
      description: '회의 내용을 정리해 위키에 페이지로 남긴다',
      argsSchema: { raw: z.string(), parent_id: z.string().optional() },
    },
    ({ raw, parent_id }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            '다음 회의 내용을 정리해서 위키에 페이지로 만들어줘.\n' +
            '형식: 참석자 / 논의 사항 / 결정 사항 / 액션 아이템(담당자 + 기한).\n' +
            'list_members 로 실제 팀원 이름을 확인해서 담당자를 정확히 적어줘.\n' +
            (parent_id
              ? `상위 페이지: ${parent_id}\n`
              : '어디에 둘지는 list_pages 로 구조를 보고 정해줘.\n') +
            `\n---\n${raw}`,
        },
      }],
    }),
  )
}
