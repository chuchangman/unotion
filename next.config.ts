import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 이 목록은 두 가지를 동시에 피하기 위한 것이다.
   *  - 번들하면: 라우트 핸들러는 react-server 레이어라 React.createContext 가 없어
   *    BlockNote 변환기가 런타임에 "createContext is not a function" 으로 죽는다.
   *  - external 로 두면: Node 가 실제 require 로 로드하므로 위 문제가 사라진다.
   *    단 jsdom 체인이 CJS 여야 한다 (package.json overrides.jsdom 참고).
   * yjs 를 함께 빼는 것도 중요하다. 하나는 번들, 하나는 외부로 로드되면
   * Yjs 인스턴스가 둘이 되어 instanceof 검사가 깨진다.
   */
  serverExternalPackages: [
    '@blocknote/server-util',
    '@blocknote/core',
    // 다단 블록. core 와 **같이** 빠져야 한다 — 하나만 번들되면 BlockNote
    // 인스턴스가 둘이 되어 스키마 대조가 깨진다 (아래 yjs 와 같은 이유)
    '@blocknote/xl-multi-column',
    'jsdom',
    'yjs',
    'y-protocols',
    'y-prosemirror',
  ],
  /**
   * 동적 라우트의 클라이언트 캐시(Router Cache) 수명.
   *
   * Next 15 부터 dynamic 기본값이 0 이라 **뒤로가기조차 매번 서버 왕복**이었다.
   * 문서를 오가는 동작이 팀 위키에서 가장 잦은 경로라 30초를 준다 —
   * 방금 본 문서로 돌아가는 건 즉시 그려진다.
   *
   * 대가: 다른 사람이 30초 안에 고친 제목·코멘트 수 같은 서버 렌더 값이
   * 즉시 안 보일 수 있다. 본문 자체는 Yjs 로 실시간 동기화되므로 영향 없고,
   * 뮤테이션은 revalidatePath 로 캐시를 즉시 무효화한다.
   */
  experimental: {
    staleTimes: { dynamic: 30 },
  },
};

export default nextConfig;
