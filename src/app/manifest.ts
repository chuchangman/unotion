import type { MetadataRoute } from 'next'

/**
 * 홈 화면에 앱으로 설치하기 위한 manifest (/manifest.webmanifest).
 *
 * 노트북 마이크가 없을 때 **휴대폰으로 회의를 녹음**하려고 둔다.
 * 브라우저 탭으로 열면 주소창이 화면을 먹고, 실수로 탭을 닫기 쉽다.
 *
 * ★ 서비스 워커는 두지 않는다
 *   크롬은 더 이상 설치 조건으로 서비스 워커를 요구하지 않고, iOS 는 원래 안 본다.
 *   오프라인 캐시를 붙이면 배포 직후 옛 화면이 남는 문제가 생기는데, 이 앱은
 *   어차피 서버·실시간 동기화 없이는 쓸 데가 없다.
 *
 * ★ proxy.ts 의 matcher 에서 이 경로를 뺐다. 브라우저는 manifest 를 쿠키 없이
 *   가져가므로, 빼지 않으면 로그인 화면으로 리다이렉트돼 설치가 안 된다.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: '우노션',
    short_name: '우노션',
    description: '우리 팀 지식베이스',
    lang: 'ko',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
