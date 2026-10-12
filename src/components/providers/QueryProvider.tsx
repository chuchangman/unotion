'use client'

/**
 * 클라이언트 조회 캐시 (TanStack Query).
 *
 * 규칙: **첫 화면은 서버 컴포넌트(RSC)가 그리고, 화면을 쓰는 동안의 조회는 Query 가 한다.**
 * 쓰기는 계속 서버 액션이다. 조회를 서버 액션으로 하면 액션이 클라이언트당 한 줄로 서서
 * 자동저장·다른 조회 뒤에서 기다린다 (Next 16 문서: "sequential dispatch").
 *
 * Query 가 대신 해 주는 것: 같은 질의의 중복 제거, 늦게 온 옛 응답 버리기, 다시 열 때 캐시로
 * 즉시 그리기, 실시간 무효화(10번 — 다른 사람이 바꾸면 해당 키만 다시 읽는다).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // 팀 위키는 초 단위로 바뀌지 않는다. 바뀌면 실시간 채널이 해당 키를 무효화한다
        staleTime: 30_000,
        // 탭 복귀마다 전부 다시 읽지 않는다 — 본문은 프로바이더가 따로 당겨 온다
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
