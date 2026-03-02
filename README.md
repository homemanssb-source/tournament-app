# 🎾 Phase 2+3: 프론트엔드 (공개뷰 + PIN 기능)

## 설치 & 실행

```bash
cd phase2-frontend
npm install
cp .env.local.example .env.local   # Supabase URL/Key 입력
npm run dev
```

## 환경변수 (.env.local)

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

## 포함된 페이지

| 경로 | 기능 | 인증 |
|------|------|------|
| `/` | 홈 (네비게이션) | 없음 |
| `/events` | 대회 목록 | 없음 |
| `/events/[id]` | 대회 상세 (4탭) | 없음 |
| → 조 게시 | 부서별 조편성 카드 | 없음 |
| → 토너먼트 | 부서별 싱글엘리미 브래킷 | 없음 |
| → 경기결과 | 예선+본선 전체 경기 리스트 | 없음 |
| → 코트현황 | 코트별 배정표 | 없음 |
| `/pin` | 참가자 PIN 입력 | PIN |
| `/pin/matches` | 내 경기 목록 + 점수 입력 | PIN 세션 |
| `/admin-pin` | 마스터 PIN 입력 | 마스터PIN |
| `/admin-pin/manage` | 경기 검색/잠금해제/결과수정 | 마스터PIN 세션 |

## 컴포넌트

| 파일 | 역할 |
|------|------|
| `TournamentBracket.tsx` | 부서별 싱글 엘리미네이션 브래킷 트리 |
| `CourtBoard.tsx` | 코트별 배정 현황 보드 |

## 파일 구조

```
src/
├── lib/supabase.ts           ← 클라이언트 + 타입
├── app/
│   ├── layout.tsx
│   ├── page.tsx               ← 홈
│   ├── globals.css
│   ├── events/
│   │   ├── page.tsx           ← 대회 목록
│   │   └── [id]/page.tsx      ← 대회 상세 (4탭)
│   ├── pin/
│   │   ├── page.tsx           ← PIN 입력
│   │   └── matches/page.tsx   ← 경기+점수 입력
│   └── admin-pin/
│       ├── page.tsx           ← 마스터PIN 입력
│       └── manage/page.tsx    ← 관리 (검색/해제/수정)
└── components/
    ├── TournamentBracket.tsx
    └── CourtBoard.tsx
```

## 다음 단계

Phase 4에서 운영자 대시보드 (로그인/팀관리/조편성/경기관리/토너먼트생성/코트배정)를 추가합니다.
