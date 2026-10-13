'use client';
// 순위 화면은 조편성 화면 안으로 합쳐짐 — 예전 주소(북마크·링크)는 그쪽 순위 영역으로 보냄

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useEventIdWithParam } from '@/components/useDashboard';

export default function StandingsRedirect() {
  const router = useRouter();
  const eventId = useEventIdWithParam();
  useEffect(() => {
    router.replace(`/dashboard/teams/groups${eventId ? `?event_id=${eventId}` : ''}#standings`);
  }, [router, eventId]);
  return <div className="p-8 text-center text-gray-400">순위는 조편성 화면으로 옮겨졌습니다. 이동 중…</div>;
}
