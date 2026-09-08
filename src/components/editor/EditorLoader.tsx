'use client'

import dynamic from 'next/dynamic'
import type { EditorProps } from './Editor'

/**
 * BlockNote 는 브라우저에서만 초기화된다 (useCreateBlockNote 가 window 를 참조).
 * 'use client' 만으로는 부족하다 — Next 는 클라이언트 컴포넌트도 서버에서 한 번
 * 렌더링하기 때문에 SSR 단계에서 "window is not defined" 로 터진다.
 *
 * ssr:false 는 서버 컴포넌트에서 쓸 수 없으므로 이 클라이언트 래퍼를 거친다.
 */
const Editor = dynamic(
  () => import('./Editor').then((m) => m.Editor),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-3 py-2" aria-hidden>
        <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      </div>
    ),
  },
)

export function EditorLoader(props: EditorProps) {
  return <Editor {...props} />
}
