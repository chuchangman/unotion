'use client'

import { useSyncExternalStore } from 'react'
import { colorFor, getPeers, subscribePeers, type Peer } from '@/lib/realtime/presence'

/** 이보다 많으면 +N 으로 줄인다 */
const MAX_SHOWN = 4
const NOBODY: Peer[] = []

/**
 * 지금 이 문서를 함께 열어 둔 사람. 도구 모음 왼쪽 끝에 선다.
 *
 * 편집 권한이 있는 사람만 보인다 — 문서 채널에 보낼 수 있는 건 편집자뿐이라
 * (drizzle/0005) 읽기 전용으로 연 사람은 자기가 왔다는 것도 알리지 못한다.
 * 아무도 없으면 자리를 차지하지 않는다. 도구 모음 버튼과 높이가 같아서 나타나도
 * 본문이 밀리지 않는다.
 */
export function PresenceAvatars({ pageId }: { pageId: string }) {
  const peers = useSyncExternalStore(subscribePeers, () => getPeers(pageId), () => NOBODY)
  if (peers.length === 0) return null

  const shown = peers.slice(0, MAX_SHOWN)
  const hidden = peers.slice(MAX_SHOWN)
  return (
    <div
      role="group"
      aria-label={`함께 있는 사람 ${peers.length}명`}
      className="mr-auto flex items-center -space-x-1.5"
    >
      {shown.map((p) => (
        <span
          key={p.id}
          role="img"
          aria-label={p.name}
          title={p.name}
          className="flex size-6 items-center justify-center rounded-full text-[11px] font-medium text-white ring-2 ring-background"
          style={{ backgroundColor: colorFor(p.id) }}
        >
          {initial(p.name)}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.map((p) => p.name).join(', ')}
          className="flex size-6 items-center justify-center rounded-full bg-neutral-200 text-[10px] font-medium text-neutral-600 ring-2 ring-background dark:bg-neutral-700 dark:text-neutral-200"
        >
          +{hidden.length}
        </span>
      )}
    </div>
  )
}

/** 이름의 첫 글자. 한글은 첫 음절, 이모지도 한 글자로 센다 */
function initial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}
