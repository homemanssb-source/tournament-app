'use client'
import { useEffect, useRef } from 'react'

// 폰 화면을 껐다 켜거나(앱 복귀), 인터넷이 다시 연결되면 바로 다시 불러오기.
// 화면이 꺼진 동안 밀린 자동 새로고침은 인터넷이 끊긴 상태에서 실패하기 쉬워서,
// 복귀 직후 한 번 더(조금 늦게) 불러온다.
export function useRefreshOnWake(reload: () => void) {
  const ref = useRef(reload)
  ref.current = reload
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = () => {
      if (document.visibilityState !== 'visible') return
      ref.current()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => ref.current(), 2500)
    }
    document.addEventListener('visibilitychange', run)
    window.addEventListener('online', run)
    window.addEventListener('pageshow', run)
    return () => {
      document.removeEventListener('visibilitychange', run)
      window.removeEventListener('online', run)
      window.removeEventListener('pageshow', run)
      if (timer) clearTimeout(timer)
    }
  }, [])
}
