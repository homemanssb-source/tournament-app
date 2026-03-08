'use client'
// src/hooks/usePushSubscription.ts
// 기존 usePushNotification.ts 와 별개 파일 (충돌 없음)
// 용도: 선수가 PIN 입력 후 푸시 구독 등록

import { useState, useCallback } from 'react'

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray.buffer as ArrayBuffer
}

export function usePushSubscription() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const subscribeWithPin = useCallback(async (pin: string): Promise<boolean> => {
    // 브라우저 지원 확인
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('error')
      setMessage('이 브라우저는 푸시 알림을 지원하지 않습니다.')
      return false
    }

    if (!VAPID_PUBLIC_KEY) {
      // VAPID 키 없으면 조용히 skip (개발 환경)
      console.warn('[Push] VAPID_PUBLIC_KEY not set, skipping push subscription')
      return false
    }

    setStatus('loading')

    try {
      // 1. 알림 권한 요청
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus('idle')
        return false
      }

      // 2. Service Worker 등록 대기
      const reg = await navigator.serviceWorker.ready

      // 3. 기존 구독 확인 or 새로 구독
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
      }

      // 4. 서버에 PIN + 구독 정보 저장
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          subscription: {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.toJSON().keys?.p256dh,
              auth:   sub.toJSON().keys?.auth,
            },
          },
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setStatus('error')
        setMessage(data.error || '구독 저장 실패')
        return false
      }

      setStatus('success')
      setMessage(`${data.team_name} 알림 등록 완료!`)
      return true

    } catch (err) {
      console.error('[Push] subscribeWithPin error:', err)
      setStatus('error')
      setMessage('알림 등록 중 오류가 발생했습니다.')
      return false
    }
  }, [])

  return { status, message, subscribeWithPin }
}
