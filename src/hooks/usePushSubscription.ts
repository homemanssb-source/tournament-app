'use client'
// ============================================================
// src/hooks/usePushSubscription.ts
// ✅ [FIX] visibilitychange 이벤트에 autoResubscribe 연결
//    앱이 백그라운드 → 포그라운드로 돌아올 때마다 구독 상태 체크
//    iOS PWA 재실행 시 구독 초기화 문제 해결
// ============================================================
import { useState, useCallback, useEffect } from 'react'

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i)
  return output.buffer as ArrayBuffer
}

// 서버에 구독 정보 저장
async function saveToServer(pin: string, sub: PushSubscription) {
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
  return res
}

// 서버에 endpoint 존재 여부 확인
async function checkOnServer(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch('/api/push/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
    if (!res.ok) return false
    const data = await res.json()
    return data.exists === true
  } catch {
    return false
  }
}

export type PushStatus = 'idle' | 'loading' | 'success' | 'error' | 'unsupported'

export function usePushSubscription() {
  const [status, setStatus]   = useState<PushStatus>('idle')
  const [message, setMessage] = useState('')

  // ── 최초 구독 (PIN 로그인 후 호출) ──────────────────────────
  const subscribeWithPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported')
      setMessage('이 브라우저는 푸시 알림을 지원하지 않습니다.')
      return false
    }
    if (!VAPID_PUBLIC_KEY) {
      console.warn('[Push] VAPID_PUBLIC_KEY not set')
      return false
    }

    setStatus('loading')
    try {
      // 1. 권한 요청
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus('idle')
        return false
      }

      const reg = await navigator.serviceWorker.ready

      // 2. ✅ 기존 구독 무조건 해제 후 새로 발급
      //    (endpoint 만료 방지 — 항상 최신 endpoint 사용)
      const existing = await reg.pushManager.getSubscription()
      if (existing) await existing.unsubscribe()

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })

      // 3. 서버에 저장
      const res = await saveToServer(pin, sub)
      const data = await res.json()

      if (!res.ok) {
        setStatus('error')
        setMessage(data.error || '구독 저장 실패')
        return false
      }

      // 4. ✅ localStorage에 PIN + endpoint 저장 (자동 재구독에 사용)
      localStorage.setItem('push_pin', pin)
      localStorage.setItem('push_endpoint', sub.endpoint)

      setStatus('success')
      setMessage(`${data.team_name || ''} 알림 등록 완료!`)
      return true

    } catch (err: any) {
      console.error('[Push] subscribeWithPin error:', err)
      setStatus('error')
      setMessage('알림 등록 중 오류가 발생했습니다.')
      return false
    }
  }, [])

  // ── 자동 재구독 (pin/matches 페이지 진입 시 + 포그라운드 복귀 시 호출) ──
  const autoResubscribe = useCallback(async (): Promise<void> => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    if (!VAPID_PUBLIC_KEY) return
    if (Notification.permission !== 'granted') return

    const savedPin      = localStorage.getItem('push_pin')
    const savedEndpoint = localStorage.getItem('push_endpoint')
    if (!savedPin) return  // 한 번도 등록 안 한 사용자는 건드리지 않음

    try {
      const reg        = await navigator.serviceWorker.ready
      const currentSub = await reg.pushManager.getSubscription()

      // 케이스 1: 브라우저 구독 자체가 사라진 경우 (iOS PWA 재실행 등)
      if (!currentSub) {
        console.log('[Push] 구독 없음 → 자동 재구독')
        const newSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
        await saveToServer(savedPin, newSub)
        localStorage.setItem('push_endpoint', newSub.endpoint)
        return
      }

      // 케이스 2: endpoint가 변경된 경우
      if (currentSub.endpoint !== savedEndpoint) {
        console.log('[Push] endpoint 변경 → 재등록')
        await saveToServer(savedPin, currentSub)
        localStorage.setItem('push_endpoint', currentSub.endpoint)
        return
      }

      // 케이스 3: 서버 DB에 구독이 없는 경우 (DB 초기화 등)
      const existsOnServer = await checkOnServer(currentSub.endpoint)
      if (!existsOnServer) {
        console.log('[Push] 서버에 구독 없음 → 재등록')
        await saveToServer(savedPin, currentSub)
      }

    } catch (err) {
      // 자동 재구독 실패는 조용히 처리 (UX 방해 안 함)
      console.warn('[Push] autoResubscribe error:', err)
    }
  }, [])

  // ✅ [FIX] visibilitychange: 앱이 포그라운드로 돌아올 때마다 구독 상태 재확인
  //    iOS PWA에서 홈버튼 → 재진입 시 구독이 초기화되는 경우를 커버
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        autoResubscribe()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [autoResubscribe])

  return { status, message, subscribeWithPin, autoResubscribe }
}
