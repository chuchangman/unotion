import type { Metadata } from "next";
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
   * 문서 화면은 서버에서 제목을 정하지 않고 **브라우저에서** 갱신한다 —
   * 제목을 고치는 즉시 탭에 반영돼야 하고, 그러자고 DB 왕복을 하나 더
   * 만들 이유는 없기 때문이다 (PageHeader 의 document.title 주석 참고).
   */
  title: { default: '우노션', template: '%s · 우노션' },
  description: '우리 팀 지식베이스',
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
