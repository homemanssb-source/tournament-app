'use client'
// src/components/PushHelp.tsx
// 알림을 켤 수 없는 폰에서 "왜 안 되는지 / 어떻게 하면 되는지" 안내
//
// H.B컵(2026-09-19): 체크인 25팀 중 알림 등록 10팀. 알림이 안 되는 흔한 경우
// - 카카오톡 등 앱 안의 브라우저로 링크를 연 경우 (웹 푸시 자체가 없음)
// - 아이폰 사파리: '홈 화면에 추가'한 아이콘으로 열어야만 알림 가능 (iOS 16.4+)
// - 예전에 알림을 '차단'한 경우

import { useEffect, useState } from 'react'

export type PushEnv = 'ok' | 'inapp_kakao' | 'inapp_other' | 'ios_need_home' | 'denied' | 'unsupported'

export function detectPushEnv(): PushEnv {
  const ua = navigator.userAgent
  if (/KAKAOTALK/i.test(ua)) return 'inapp_kakao'
  if (/NAVER\(inapp|Instagram|FBAN|FBAV|\bLine\/|DaumApps|BAND\/|; wv\)/i.test(ua)) return 'inapp_other'
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true
  if (ios && !standalone) return 'ios_need_home'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return 'ok'
}

// 서버 렌더와 어긋나지 않게 첫 렌더는 null, 마운트 뒤 판단
export function usePushEnv(): PushEnv | null {
  const [env, setEnv] = useState<PushEnv | null>(null)
  useEffect(() => {
    setEnv(detectPushEnv())
    // 설정에서 권한을 바꾸고 돌아온 경우 다시 판단
    const onVis = () => { if (document.visibilityState === 'visible') setEnv(detectPushEnv()) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  return env
}

function openInExternalBrowser() {
  location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href)
}

// env 가 'ok' 이거나 아직 모르면 아무것도 그리지 않음
export default function PushHelp({ env, compact = false }: { env: PushEnv | null; compact?: boolean }) {
  if (!env || env === 'ok') return null
  const box = `rounded-xl border border-amber-200 bg-amber-50 text-left text-amber-900 ${compact ? 'p-3 text-xs' : 'p-4 text-sm'} space-y-2`

  if (env === 'inapp_kakao') return (
    <div className={box}>
      <p className="font-bold">📵 카카오톡 안에서는 알림을 받을 수 없어요</p>
      <p>아래 버튼으로 <b>크롬·사파리</b>에서 다시 열고 PIN을 입력해 주세요.</p>
      <button onClick={openInExternalBrowser}
        className="w-full bg-amber-500 text-white font-bold py-2.5 rounded-lg hover:bg-amber-600">
        🌐 다른 브라우저로 열기
      </button>
    </div>
  )

  if (env === 'inapp_other') return (
    <div className={box}>
      <p className="font-bold">📵 앱 안의 브라우저에서는 알림을 받을 수 없어요</p>
      <p>오른쪽 위 <b>⋮ 또는 공유 메뉴 → &apos;다른 브라우저로 열기&apos;</b>로 크롬·사파리에서 열고 PIN을 다시 입력해 주세요.</p>
    </div>
  )

  if (env === 'ios_need_home') return (
    <div className={box}>
      <p className="font-bold">🍎 아이폰은 &apos;홈 화면에 추가&apos;해야 알림이 와요</p>
      <ol className="list-decimal pl-5 space-y-0.5">
        <li>사파리 아래쪽 <b>공유 버튼(□↑)</b> 누르기</li>
        <li><b>&apos;홈 화면에 추가&apos;</b> 누르기</li>
        <li>홈 화면의 <b>&apos;테니스대회&apos;</b> 아이콘으로 열고 PIN 다시 입력 → 알림 켜기</li>
      </ol>
      <p className="text-amber-700/80">iOS 16.4 이상에서 됩니다. 크롬 앱이라면 사파리로 열어 주세요.</p>
    </div>
  )

  if (env === 'denied') return (
    <div className={box}>
      <p className="font-bold">🔕 이 폰에서 알림이 차단돼 있어요</p>
      <p><b>안드로이드 크롬</b>: 주소창 왼쪽 아이콘 → 권한(사이트 설정) → 알림 <b>허용</b> → 새로고침</p>
      <p><b>아이폰</b>: 설정 앱 → 알림 → <b>테니스대회</b> → 알림 허용</p>
    </div>
  )

  return (
    <div className={box}>
      <p className="font-bold">📵 이 브라우저는 알림을 지원하지 않아요</p>
      <p>안드로이드는 <b>크롬</b>, 아이폰은 <b>사파리 → 홈 화면에 추가</b>로 열어 주세요.</p>
    </div>
  )
}
