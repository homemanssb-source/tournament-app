'use client'

import { usePushNotification } from '@/hooks/usePushNotification'

export default function NotificationButton() {
  const {
    isSupported,
    permission,
    isLoading,
    isSubscribed,
    subscribe,
    unsubscribe,
    sendTestNotification,
  } = usePushNotification()

  if (!isSupported) return null

  if (permission === 'denied') {
    return (
      <div className="text-sm text-red-500 px-3 py-2 rounded-lg bg-red-50">
        🔕 알림이 차단되어 있습니다. 브라우저 설정에서 허용해 주세요.
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {/* 알림 켜기/끄기 버튼 */}
      <button
        onClick={isSubscribed ? unsubscribe : subscribe}
        disabled={isLoading}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
          transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed
          ${isSubscribed
            ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            : 'bg-orange-500 text-white hover:bg-orange-600 shadow-md'
          }
        `}
      >
        {isLoading ? (
          <span className="animate-spin">⏳</span>
        ) : isSubscribed ? (
          <>🔔 알림 켜짐</>
        ) : (
          <>🔕 알림 받기</>
        )}
      </button>

      {/* 테스트 버튼 (알림 허용된 경우만) */}
      {permission === 'granted' && (
        <button
          onClick={sendTestNotification}
          className="px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition-colors"
          title="테스트 알림 보내기"
        >
          🧪
        </button>
      )}
    </div>
  )
}
