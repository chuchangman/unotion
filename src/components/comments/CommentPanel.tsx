'use client'

/**
 * 코멘트 패널. 페이지 단위 스레드.
 *
 * 편집 권한이 없어도 comment 레벨이면 쓸 수 있다 (permissions.ts 의 read < comment < edit).
 * 위키에서 "고칠 순 없지만 의견은 남긴다"가 실제로 가장 흔한 경우다.
 *
 * 인라인(블록에 붙는) 코멘트는 스키마(comments.block_id)와 코어가 이미 받지만
 * 아직 화면이 없다. 여기서 만드는 스레드는 block_id 가 null 이다.
 */
import { useState, useTransition } from 'react'
import { AtSign, Check, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react'
import * as Actions from '@/app/actions/comments'
import type { CommentThread } from '@/lib/core/comments'

type Member = { id: string; displayName: string; email: string }

export function CommentPanel({
  pageId, workspaceId, canComment, currentUserId, openCount,
}: {
  pageId: string
  workspaceId: string
  canComment: boolean
  currentUserId: string
  openCount: number
}) {
  const [open, setOpen] = useState(false)
  const [threads, setThreads] = useState<CommentThread[] | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [draft, setDraft] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState('')
  const [, start] = useTransition()

  /**
   * 멘션 후보는 @ 를 눌렀을 때 한 번만 불러온다.
   * 패널을 열 때마다 부르면 코멘트를 안 달아도 왕복이 하나 생긴다.
   */
  const loadMembers = () => {
    if (members) return
    start(async () => {
      const res = await Actions.listMentionables(workspaceId)
      if (res.ok) setMembers(res.data)
      else setError(res.message)
    })
  }

  const load = (includeResolved: boolean) =>
    start(async () => {
      const res = await Actions.listThreads(pageId, includeResolved)
      if (res.ok) setThreads(res.data)
      else setError(res.message)
    })

  const openPanel = () => {
    setOpen(true)
    setError('')
    load(showResolved)
  }

  const toggleResolved = () => {
    const next = !showResolved
    setShowResolved(next)
    setThreads(null)
    load(next)
  }

  const addThread = () => {
    const body = draft.trim()
    if (!body) return
    start(async () => {
      const res = await Actions.createThread(pageId, body, mentions)
      if (!res.ok) { setError(res.message); return }
      setDraft('')
      setMentions([])
      setThreads((prev) => [
        ...(prev ?? []),
        { id: res.data.threadId, blockId: null, resolvedAt: null, comments: [res.data] },
      ])
    })
  }

  const addReply = (threadId: string, body: string, replyMentions: string[]) =>
    start(async () => {
      const res = await Actions.replyToThread(threadId, body, replyMentions)
      if (!res.ok) { setError(res.message); return }
      setThreads((prev) =>
        (prev ?? []).map((t) =>
          t.id === threadId ? { ...t, comments: [...t.comments, res.data] } : t,
        ),
      )
    })

  const setResolved = (threadId: string, resolved: boolean) =>
    start(async () => {
      const res = await Actions.resolveThread(threadId, resolved)
      if (!res.ok) { setError(res.message); return }
      // 미해결만 보는 중이면 해결된 스레드는 목록에서 빠진다
      setThreads((prev) =>
        (prev ?? [])
          .map((t) => (t.id === threadId ? { ...t, resolvedAt: resolved ? new Date() : null } : t))
          .filter((t) => showResolved || !t.resolvedAt),
      )
    })

  const remove = (commentId: string, threadId: string, isRoot: boolean) =>
    start(async () => {
      const res = await Actions.deleteComment(commentId)
      if (!res.ok) { setError(res.message); return }
      setThreads((prev) =>
        (prev ?? [])
          .map((t) =>
            t.id === threadId
              ? { ...t, comments: t.comments.filter((c) => c.id !== commentId) }
              : t,
          )
          .filter((t) => !(t.id === threadId && isRoot)),
      )
    })

  const visible = threads ?? []

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <MessageSquare className="size-3.5" />
        코멘트
        {openCount > 0 && (
          <span className="rounded-full bg-neutral-200 px-1.5 text-[10px] font-medium text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
            {openCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button
            type="button"
            aria-label="코멘트 닫기"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-neutral-900/20"
          />

          <aside
            role="dialog"
            aria-label="코멘트"
            className="relative flex h-full w-96 flex-col border-l border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
          >
            <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
              <h2 className="text-sm font-medium">코멘트</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={toggleResolved}
                  className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {showResolved ? '미해결만' : '해결됨 포함'}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="닫기"
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <X className="size-4" />
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

              {threads === null ? (
                <p className="py-6 text-center text-sm text-neutral-400">불러오는 중…</p>
              ) : visible.length === 0 ? (
                <p className="py-6 text-center text-sm text-neutral-400">
                  {showResolved ? '코멘트가 없습니다.' : '미해결 코멘트가 없습니다.'}
                </p>
              ) : (
                <ul className="space-y-4">
                  {visible.map((thread) => (
                    <Thread
                      key={thread.id}
                      thread={thread}
                      canComment={canComment}
                      currentUserId={currentUserId}
                      members={members}
                      onLoadMembers={loadMembers}
                      onReply={addReply}
                      onResolve={setResolved}
                      onDelete={remove}
                    />
                  ))}
                </ul>
              )}
            </div>

            {canComment && (
              <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="코멘트 남기기…"
                  rows={2}
                  className="w-full resize-none rounded-lg border border-neutral-200 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700"
                />
                <div className="mt-2 flex items-center gap-2">
                  <MentionPicker
                    members={members}
                    onOpen={loadMembers}
                    onPick={(m) => {
                      setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}@${m.displayName} `)
                      setMentions((prev) => (prev.includes(m.id) ? prev : [...prev, m.id]))
                    }}
                  />
                  {mentions.length > 0 && (
                    <span className="text-[11px] text-neutral-400">{mentions.length}명에게 알림</span>
                  )}
                  <button
                    type="button"
                    onClick={addThread}
                    disabled={!draft.trim()}
                    className="ml-auto rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    등록
                  </button>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  )
}

/** 멤버를 골라 본문에 @이름 을 넣고 userId 를 따로 모아 준다 */
function MentionPicker({
  members, onOpen, onPick,
}: {
  members: Member[] | null
  onOpen: () => void
  onPick: (m: Member) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="사람 멘션"
        title="사람 멘션"
        onClick={() => { onOpen(); setOpen((v) => !v) }}
        className="rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
      >
        <AtSign className="size-4" />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="닫기"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            {members === null ? (
              <p className="px-2 py-2 text-xs text-neutral-400">불러오는 중…</p>
            ) : (
              members.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onPick(m); setOpen(false) }}
                  className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {m.displayName}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Thread({
  thread, canComment, currentUserId, members, onLoadMembers, onReply, onResolve, onDelete,
}: {
  thread: CommentThread
  canComment: boolean
  currentUserId: string
  members: Member[] | null
  onLoadMembers: () => void
  onReply: (threadId: string, body: string, mentions: string[]) => void
  onResolve: (threadId: string, resolved: boolean) => void
  onDelete: (commentId: string, threadId: string, isRoot: boolean) => void
}) {
  const [reply, setReply] = useState('')
  const [replyMentions, setReplyMentions] = useState<string[]>([])
  const resolved = Boolean(thread.resolvedAt)

  const send = () => {
    const body = reply.trim()
    if (!body) return
    onReply(thread.id, body, replyMentions)
    setReply('')
    setReplyMentions([])
  }

  return (
    <li
      className={
        'rounded-lg border p-3 ' +
        (resolved
          ? 'border-neutral-200 bg-neutral-50 opacity-70 dark:border-neutral-800 dark:bg-neutral-900/50'
          : 'border-neutral-200 dark:border-neutral-700')
      }
    >
      {thread.comments.map((c) => (
        <div key={c.id} className="group mb-2 last:mb-0">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium">{c.authorName ?? '알 수 없음'}</span>
            <span className="text-[11px] text-neutral-400">
              {new Date(c.createdAt).toLocaleString('ko-KR')}
            </span>
            {c.authorId === currentUserId && (
              <button
                type="button"
                onClick={() => {
                  const isRoot = c.id === thread.id
                  const replies = thread.comments.length - 1
                  /**
                   * 첫 글을 지우면 답글까지 사라진다 (맥락 없는 답글을 남기지 않으려는
                   * 코어의 규칙이다). 답글이 있으면 그 사실을 먼저 알린다.
                   */
                  if (isRoot && replies > 0) {
                    if (!confirm(`이 스레드를 지울까요? 답글 ${replies}개도 함께 사라집니다.`)) return
                  }
                  onDelete(c.id, thread.id, isRoot)
                }}
                aria-label="코멘트 삭제"
                className="ml-auto rounded p-1 text-neutral-300 opacity-0 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-sm">{c.body}</p>
        </div>
      ))}

      {canComment && (
        <div className="mt-2 flex items-center gap-1">
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); send() }
            }}
            placeholder="답글…"
            className="min-w-0 flex-1 rounded border border-neutral-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-neutral-400 dark:border-neutral-700"
          />
          <MentionPicker
            members={members}
            onOpen={onLoadMembers}
            onPick={(m) => {
              setReply((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}@${m.displayName} `)
              setReplyMentions((prev) => (prev.includes(m.id) ? prev : [...prev, m.id]))
            }}
          />
          <button
            type="button"
            onClick={() => onResolve(thread.id, !resolved)}
            aria-label={resolved ? '다시 열기' : '해결로 표시'}
            title={resolved ? '다시 열기' : '해결로 표시'}
            className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800"
          >
            {resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          </button>
        </div>
      )}
    </li>
  )
}
