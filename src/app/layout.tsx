import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  /**
   * template 을 두면 각 화면이 자기 제목만 정해도 뒤에 앱 이름이 붙는다.
   * 문서 화면의 탭 이름은 문서 제목이 아니라 **지금 보는 프로젝트 룸** 이다
   * ((app)/layout.tsx 의 generateMetadata 주석 참고).
   */
  title: { default: '우노션', template: '%s · 우노션' },
  description: '우리 팀 지식베이스',
  // iOS 홈 화면에 추가했을 때 사파리 주소창 없이 앱처럼 뜬다 (manifest 는 app/manifest.ts)
  appleWebApp: { capable: true, title: '우노션', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  // 휴대폰 상단 상태 표시줄 색 — globals.css 의 --background 와 맞춘다
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      // 한국어 문서다. 스크린리더 발음과 브라우저 번역 제안이 이 값을 따른다
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
