'use client'

import { useState, useTransition } from 'react'
import { Copy, Check, Trash2 } from 'lucide-react'
import { issueToken, revokeToken } from '@/app/actions/tokens'

type TokenRow = {
  id: string
  name: string
  lastUsedAt: Date | null
  createdAt: Date
}

export function TokenManager({ tokens, mcpUrl }: { tokens: TokenRow[]; mcpUrl: string }) {
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, start] = useTransition()

  const create = () =>
    start(async () => {
      setError('')
      const res = await issueToken(name || 'MCP')
      if (res.ok) { setIssued(res.data.plaintext); setName('') }
      else setError(res.message)
    })

  const revoke = (id: string, label: string) =>
    start(async () => {
      if (!confirm(`"${label}" 토큰을 폐기할까요? 이 토큰을 쓰는 연결은 즉시 끊깁니다.`)) return
      const res = await revokeToken(id)
      if (!res.ok) setError(res.message)
    })

  return (
    <div className="mt-8 space-y-8">
      <section>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="토큰 이름 (예: 내 노트북)"
            className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="button"
            onClick={create}
            disabled={pending}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            발급
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>

      {issued && <IssuedToken token={issued} mcpUrl={mcpUrl} onDone={() => setIssued(null)} />}

      <section>
        <h2 className="mb-3 text-sm font-medium text-neutral-500">발급된 토큰</h2>
        {tokens.length === 0 ? (
          <p className="text-sm text-neutral-400">아직 없습니다.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-xs text-neutral-500">
                    발급 {new Date(t.createdAt).toLocaleDateString('ko-KR')}
                    {' · '}
                    {t.lastUsedAt
                      ? `마지막 사용 ${new Date(t.lastUsedAt).toLocaleString('ko-KR')}`
                      : '사용 이력 없음'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(t.id, t.name)}
                  disabled={pending}
                  aria-label="토큰 폐기"
                  className="rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-neutral-800"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

const CLIENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
] as const

type ClientId = (typeof CLIENTS)[number]['id']

function IssuedToken({ token, mcpUrl, onDone }: { token: string; mcpUrl: string; onDone: () => void }) {
  const [client, setClient] = useState<ClientId>('claude')

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        토큰이 발급되었습니다. 이 화면을 벗어나면 다시 볼 수 없습니다.
      </p>

      <div role="tablist" aria-label="연결할 도구" className="mt-4 flex gap-1">
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={client === c.id}
            onClick={() => setClient(c.id)}
            className={
              'rounded-md px-3 py-1.5 text-xs font-medium ' +
              (client === c.id
                ? 'bg-amber-900 text-amber-50 dark:bg-amber-200 dark:text-amber-950'
                : 'text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40')
            }
          >
            {c.label}
          </button>
        ))}
      </div>

      {client === 'claude' ? (
        <CopyBox
          label="터미널에 아래 명령을 붙여넣으세요"
          value={`claude mcp add --transport http unotion ${mcpUrl} --header "Authorization: Bearer ${token}"`}
        />
      ) : (
        <CodexSetup token={token} mcpUrl={mcpUrl} />
      )}

      <button
        type="button"
        onClick={onDone}
        className="mt-4 text-xs text-amber-900 underline dark:text-amber-200"
      >
        복사했습니다 — 닫기
      </button>
    </section>
  )
}

/**
 * Codex 는 토큰을 헤더가 아니라 **환경변수**에서 읽는다
 * (`codex mcp add` 에는 --header 같은 플래그가 없다). 그래서 두 단계다.
 * 환경변수는 설정한 뒤 새로 여는 터미널부터 보인다.
 */
function CodexSetup({ token, mcpUrl }: { token: string; mcpUrl: string }) {
  const [os, setOs] = useState<'win' | 'unix'>(
    typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? 'win' : 'unix',
  )

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          1. 토큰을 환경변수에 넣습니다
        </p>
        <div className="flex gap-1">
          {([['win', 'Windows'], ['unix', 'macOS · Linux']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setOs(id)}
              aria-pressed={os === id}
              className={
                'rounded px-2 py-0.5 text-[11px] ' +
                (os === id
                  ? 'bg-amber-200 font-medium text-amber-950 dark:bg-amber-800 dark:text-amber-100'
                  : 'text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40')
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <CopyBox
        value={
          os === 'win'
            ? `setx UNOTION_TOKEN "${token}"`
            : `echo 'export UNOTION_TOKEN="${token}"' >> ~/.zshrc && source ~/.zshrc`
        }
      />

      <CopyBox
        label="2. Codex 에 서버를 등록합니다"
        value={`codex mcp add unotion --url ${mcpUrl} --bearer-token-env-var UNOTION_TOKEN`}
      />

      <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
        환경변수는 새로 여는 터미널부터 적용됩니다. 등록 확인은{' '}
        <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">codex mcp list</code> 입니다.
      </p>
    </>
  )
}

function CopyBox({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <>
      {label && (
        <p className="mt-4 text-xs font-medium text-amber-900 dark:text-amber-200">{label}</p>
      )}
      <div className="mt-1 flex items-start gap-2">
        <pre className="flex-1 overflow-x-auto rounded border border-amber-300 bg-white p-2 text-xs dark:border-amber-800 dark:bg-neutral-900">
          <code>{value}</code>
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label="복사"
          className="shrink-0 rounded border border-amber-300 bg-white p-2 hover:bg-amber-100 dark:border-amber-800 dark:bg-neutral-900"
        >
          {copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
        </button>
      </div>
    </>
  )
}
