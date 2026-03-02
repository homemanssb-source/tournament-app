import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '🎾 테니스 대회 운영',
  description: '테니스 대회 조편성/토너먼트/결과 관리 시스템',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-stone-50 text-stone-900">{children}</body>
    </html>
  )
}
