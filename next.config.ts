import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * BlockNote 의 서버 변환기는 React 의 createContext 를 쓴다.
   * Next 가 라우트 핸들러를 번들할 때 'react-server' 조건으로 해석하면
   * createContext 가 없어서 "UA.createContext is not a function" 으로 죽는다.
   * 외부 의존성으로 빼면 Node 가 기본 조건으로 resolve 해서 정상 동작한다.
   */
  // yjs 를 함께 external 로 빼는 게 중요하다. 하나는 번들, 하나는 외부로 로드되면
  // Yjs 인스턴스가 둘이 되어 instanceof 검사가 깨진다 ("Yjs was already imported").
  serverExternalPackages: [
    '@blocknote/server-util',
    '@blocknote/core',
    'yjs',
    'y-protocols',
    'y-prosemirror',
  ],
  /* config options here */
};

export default nextConfig;
