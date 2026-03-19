# fix_bugs.ps1
Set-StrictMode -Off
$ErrorActionPreference = "Stop"
$root = Get-Location

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " 제주테니스 버그 수정 스크립트" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " 경로: $root" -ForegroundColor Gray
Write-Host ""

function Patch {
    param([string]$RelPath, [string]$Old, [string]$New, [string]$Label)
    $full = Join-Path $root $RelPath
    if (-not (Test-Path $full)) { Write-Host "  [SKIP] 파일없음: $RelPath" -ForegroundColor Yellow; return }
    $content = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
    if ($content.Contains($Old)) {
        $updated = $content.Replace($Old, $New)
        [System.IO.File]::WriteAllText($full, $updated, [System.Text.Encoding]::UTF8)
        Write-Host "  [OK]   $Label" -ForegroundColor Green
    } else {
        Write-Host "  [SKIP] 이미수정됨: $Label" -ForegroundColor Yellow
    }
}

Write-Host "[BUG-1] pin/page.tsx - sessionStorage 키 불일치" -ForegroundColor Cyan
Patch "src\app\pin\page.tsx" `
    "sessionStorage.setItem('pin_session', JSON.stringify(data))" `
    "sessionStorage.setItem('pin_session', JSON.stringify(data))
    sessionStorage.setItem('venue_pin', pin)
    sessionStorage.setItem('pin_event_id', selectedEvent)" `
    "pin/page.tsx: venue_pin + pin_event_id 추가 저장"

Write-Host ""
Write-Host "[BUG-2] pin/team/page.tsx - tie_rubbers 쿼리 lineup_ready 제거" -ForegroundColor Cyan
Patch "src\app\pin\team\page.tsx" `
    ".in('status', ['pending', 'in_progress', 'lineup_ready'])" `
    ".in('status', ['pending', 'in_progress'])" `
    "pin/team/page.tsx: lineup_ready 제거"

Write-Host ""
Write-Host "[BUG-3] venue/page.tsx - 단체전 코트 타입 통일 + court_order null" -ForegroundColor Cyan
Patch "src\app\venue\page.tsx" `
    "const ties: VenueMatch[] = (data.ties || []).map((t: any) => ({ ...t, is_team_tie: true }))" `
    "const ties: VenueMatch[] = (data.ties || []).map((t: any) => ({ ...t, is_team_tie: true, court: t.court_number != null ? ``코트 `${t.court_number}`` : null }))" `
    "venue/page.tsx: court_number -> 문자열 court 통일"

Patch "src\app\venue\page.tsx" `
    "await supabase.from('ties').update({ court_number: null }).eq('id', matchId)" `
    "await supabase.from('ties').update({ court_number: null, court_order: null }).eq('id', matchId)" `
    "venue/page.tsx: unassign시 court_order null 추가"

Write-Host ""
Write-Host "[BUG-4] team-api.ts - fetchTies divisionId 파라미터 추가" -ForegroundColor Cyan
Patch "src\lib\team-api.ts" `
    "export async function fetchTies(eventId: string, round?: string): Promise<TieWithClubs[]> {" `
    "export async function fetchTies(eventId: string, round?: string, divisionId?: string | null): Promise<TieWithClubs[]> {" `
    "team-api.ts: fetchTies 시그니처에 divisionId 추가"

Patch "src\lib\team-api.ts" `
    "  if (round) query = query.eq('round', round);" `
    "  if (round) query = query.eq('round', round);
  if (divisionId) query = query.eq('division_id', divisionId);" `
    "team-api.ts: divisionId 쿼리 필터 적용"

Write-Host ""
Write-Host "[BUG-5] events/[id]/page.tsx - fetchTies 서버 필터 적용" -ForegroundColor Cyan
Patch "src\app\events\[id]\page.tsx" `
    "      fetchTies(eventId),
    ])
    setTeamConfig(cfg)
    setClubs(clubList)
    const filteredTies = divId ? tieList.filter(t => (t as any).division_id === divId) : tieList
    setTies(filteredTies)" `
    "      fetchTies(eventId, undefined, divId || null),
    ])
    setTeamConfig(cfg)
    setClubs(clubList)
    setTies(tieList)" `
    "events/[id]/page.tsx: fetchTies divisionId 서버필터"

Write-Host ""
Write-Host "[WARN-6] dashboard/page.tsx - updated_at 명시" -ForegroundColor Cyan
Patch "src\app\dashboard\page.tsx" `
    "supabase.from('ties').select('*, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)').eq('event_id', eventId).eq('status', 'completed').order('updated_at', { ascending: false }).limit(5)," `
    "supabase.from('ties').select('*, updated_at, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)').eq('event_id', eventId).eq('status', 'completed').order('updated_at', { ascending: false }).limit(5)," `
    "dashboard/page.tsx: updated_at 명시"

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " 완료! 다음 명령으로 확인하세요:" -ForegroundColor Green
Write-Host "   npm run build" -ForegroundColor White
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""
