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
    'jsdom',
    'yjs',
    'y-protocols',
    'y-prosemirror',
  ],
  /**
   * BlockNote 의 서버 변환기는 React 의 createContext 를 쓴다.
   * Next 가 라우트 핸들러를 번들할 때 'react-server' 조건으로 해석하면
   * createContext 가 없어서 "UA.createContext is not a function" 으로 죽는다.
   * 외부 의존성으로 빼면 Node 가 기본 조건으로 resolve 해서 정상 동작한다.
   */
  /**
   * BlockNote 서버 변환기를 external 로 빼면 Vercel 람다에서
   * Turbopack 의 external 로더가 jsdom 체인의 CJS->ESM require 를 못 다뤄
   * ERR_REQUIRE_ESM 으로 라우트 전체가 500 이 된다.
   * 그래서 번들시키고, 빌드 타임 createContext 오류는
   * lib/core/markdown.ts 의 지연 import 로 회피한다.
   */
  /* config options here */
};

export default nextConfig;
