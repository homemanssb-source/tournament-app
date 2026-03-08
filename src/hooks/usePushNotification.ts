'use client'

import { useState, useEffect, useCallback } from 'react'

// ── VAPID 공개키 (서버에서 발급 후 여기에 붙여넣기) ──
// 테스트용으로 빈값이면 알림 구독은 안 되지만 권한 요청은 됩니다
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

export type NotificationPermission = 'default' | 'granted' | 'denied'

export function usePushNotification() {
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [subscription, setSubscription] = useState<PushSubscription | null>(null)
  const [isSupported, setIsSupported] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  // 지원 여부 & 현재 권한 초기화
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator) {
      setIsSupported(true)
      setPermission(Notification.permission as NotificationPermission)
    }
  }, [])

  // 기존 구독 확인
  useEffect(() => {
    if (!isSupported) return
    navigator.serviceWorker.ready.then(reg => {
      reg.pushManager.getSubscription().then(sub => {
        if (sub) setSubscription(sub)
      })
    })
  }, [isSupported])

  // 권한 요청 & 구독
  const subscribe = useCallback(async () => {
    if (!isSupported) return null
    setIsLoading(true)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm as NotificationPermission)
      if (perm !== 'granted') return null

      const reg = await navigator.serviceWorker.ready

      // 기존 구독이 있으면 재사용
      let sub = await reg.pushManager.getSubscription()
      if (!sub && VAPID_PUBLIC_KEY) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
      }

      setSubscription(sub)

      // TODO: 서버에 구독 정보 저장
      // await fetch('/api/push/subscribe', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(sub),
      // })

      return sub
    } catch (err) {
      console.error('[Push] 구독 오류:', err)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [isSupported])

  // 구독 해제
  const unsubscribe = useCallback(async () => {
    if (!subscription) return
    setIsLoading(true)
    try {
      await subscription.unsubscribe()
      setSubscription(null)

      // TODO: 서버에서 구독 정보 삭제
      // await fetch('/api/push/unsubscribe', { method: 'POST' })
    } catch (err) {
      console.error('[Push] 구독 해제 오류:', err)
    } finally {
      setIsLoading(false)
    }
  }, [subscription])

  // 로컬 테스트 알림 (서버 없이 바로 테스트)
  const sendTestNotification = useCallback(async () => {
    if (permission !== 'granted') {
      await subscribe()
      return
    }
    const reg = await navigator.serviceWorker.ready
    reg.showNotification('🎾 테스트 알림', {
      body: '알림이 정상적으로 작동합니다!',
      icon: '/icon-192x192.png',
      badge: '/icon-72x72.png',
      vibrate: [200, 100, 200],
    })
  }, [permission, subscribe])

  return {
    isSupported,
    permission,
    subscription,
    isLoading,
    isSubscribed: !!subscription && permission === 'granted',
    subscribe,
    unsubscribe,
    sendTestNotification,
  }
}