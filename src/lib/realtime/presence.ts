/**
 * 접속자 표시 — 에디터의 awareness 를 페이지의 다른 자리(도구 모음)에서 읽는다.
 *
 * awareness 는 에디터가 만들고 에디터와 함께 사라진다. 아바타는 에디터 **밖**
 * (공유·코멘트 버튼 옆)에 그려야 본문 위를 가리지 않으므로, 에디터가 pageId 로
 * 여기에 걸어 두고 도구 모음이 같은 pageId 로 꺼내 본다.
 *
 * 다른 사람의 상태는 네트워크에서 온 값이다. 모양을 검사하고, 색은 받지 않고
 * id 에서 여기서 다시 만든다 — 남이 보낸 문자열을 style 에 넣지 않는다.
 *
 * y-protocols 는 타입으로만 쓴다. 도구 모음 쪽 번들에 yjs 를 끌고 오지 않는다.
 */
import type { Awareness } from 'y-protocols/awareness'

export type Peer = { id: string; name: string }

const USER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

/** 같은 사람은 어느 탭·어느 화면에서나 같은 색 (커서 색과도 같다) */
export function colorFor(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return USER_COLORS[Math.abs(h) % USER_COLORS.length]
}

type Entry = { peers: Peer[] }
/** 같은 문서를 본문과 미리보기에 함께 열 수 있어 pageId 하나에 여럿. 먼저 건 쪽을 보여 준다 */
const entries = new Map<string, Entry[]>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

function asPeer(value: unknown): Peer | null {
  if (!value || typeof value !== 'object') return null
  const { id, name } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string') return null
  return { id, name: name.slice(0, 60) }
}

/** 나를 뺀 접속자. 같은 사람이 탭을 여러 개 열었으면 한 번만 */
function readPeers(awareness: Awareness, selfId: string): Peer[] {
  const seen = new Map<string, Peer>()
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return
    const peer = asPeer(state.presence)
    if (!peer || peer.id === selfId || seen.has(peer.id)) return
    seen.set(peer.id, peer)
  })
  return [...seen.values()]
}

function samePeers(a: Peer[], b: Peer[]) {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.name === b[i].name)
}

/**
 * 에디터가 부른다. 돌려주는 함수로 내린다.
 *
 * awareness 의 'change' 는 남의 커서가 움직일 때마다 온다. 접속자 목록이 그대로면
 * 알리지 않아 도구 모음이 다시 그려지지 않는다.
 */
export function publishPresence(pageId: string, awareness: Awareness, selfId: string): () => void {
  const entry: Entry = { peers: readPeers(awareness, selfId) }
  const onChange = () => {
    const next = readPeers(awareness, selfId)
    if (samePeers(entry.peers, next)) return
    entry.peers = next
    notify()
  }
  awareness.on('change', onChange)
  entries.set(pageId, [...(entries.get(pageId) ?? []), entry])
  notify()
  return () => {
    awareness.off('change', onChange)
    const rest = (entries.get(pageId) ?? []).filter((e) => e !== entry)
    if (rest.length > 0) entries.set(pageId, rest)
    else entries.delete(pageId)
    notify()
  }
}

const NOBODY: Peer[] = []

export function getPeers(pageId: string): Peer[] {
  return entries.get(pageId)?.[0]?.peers ?? NOBODY
}

export function subscribePeers(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
