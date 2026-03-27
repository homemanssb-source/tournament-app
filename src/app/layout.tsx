import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '제주시 테니스 대회',
  description: '제주시 테니스 대회 운영 시스템',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: '테니스대회',
  },
  icons: {
    icon: '/favicon.png',
    apple: '/icon-152x152.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#ff5520',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="apple-touch-icon" sizes="192x192" href="/icon-192x192.png" />
      </head>
      <body>
        {children}

        {/* Service Worker 등록 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js')
                    .then(function(reg) { console.log('[SW] 등록 완료:', reg.scope); })
                    .catch(function(err) { console.error('[SW] 오류:', err); });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  )
}
