'use client'
// src/components/PinSubscribeButton.tsx
// 기존 PIN 입력 페이지에 이 버튼만 추가하면 됩니다
// 사용법: <PinSubscribeButton pin={pin} onSuccess={() => {}} />

import { usePushSubscription } from '@/hooks/usePushSubscription'
import PushHelp, { usePushEnv } from '@/components/PushHelp'

interface Props {
  pin: string          // 선수/팀장이 입력한 PIN
  mode?: 'individual' | 'team'   // 기본 undefined (자동 폴백, 구버전 호환)
  eventId?: string                // 현재 대회 스코프
  onSuccess?: () => void
}

export default function PinSubscribeButton({ pin, mode, eventId, onSuccess }: Props) {
  const { status, message, subscribeWithPin } = usePushSubscription()
  const env = usePushEnv()

  // 알림을 켤 수 없는 폰이면 버튼 대신 방법 안내 (예전엔 조용히 숨겨서 왜 없는지 몰랐음)
  if (env && env !== 'ok' && status !== 'success') return <PushHelp env={env} compact />

  async function handleClick() {
    if (!pin || pin.length < 6) return
    const ok = await subscribeWithPin(pin, { mode, eventId })
    if (ok && onSuccess) onSuccess()
  }

  if (status === 'success') {
    return (
      <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 px-4 py-2 rounded-xl">
        <span>🔔</span>
        <span>{message}</span>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <button
        onClick={handleClick}
        disabled={status === 'loading' || pin.length < 6}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-stone-200
          text-sm font-medium text-stone-600 hover:border-blue-400 hover:text-blue-600
          disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {status === 'loading' ? (
          <><span className="animate-spin">⏳</span> 알림 등록 중...</>
        ) : (
          <><span>🔔</span> 코트 배정 알림 받기</>
        )}
      </button>
      {status === 'error' && (
        <p className="text-xs text-red-500 text-center">{message}</p>
      )}
      <p className="text-xs text-stone-400 text-center">
        내 코트 차례가 되면 앱이 꺼져 있어도 알림이 와요
      </p>
    </div>
  )
}
