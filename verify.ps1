$base = "$env:USERPROFILE\OneDrive\바탕 화면\tournament\phase2-frontend\src\app"
$pass = 0; $fail = 0

function Check($label, $file, $pattern) {
    if (-not (Test-Path $file)) {
        Write-Host "  [없음] $label" -ForegroundColor Red; $script:fail++; return
    }
    $c = Get-Content $file -Raw -Encoding UTF8
    if ($c -match [regex]::Escape($pattern)) {
        Write-Host "  [OK]   $label" -ForegroundColor Green; $script:pass++
    } else {
        Write-Host "  [FAIL] $label" -ForegroundColor Red; $script:fail++
    }
}

Write-Host "`n[01] page.tsx - BUG#4 ties 통계" -ForegroundColor Cyan
Check "ties in_progress 조회" "$base\page.tsx" "from('ties')"
Check "tieInProgress 합산"    "$base\page.tsx" "tieInProgress"

Write-Host "`n[02] teams/ties/page.tsx - BUG#1" -ForegroundColor Cyan
Check "all 제거 (빈 문자열)"    "$base\dashboard\teams\ties\page.tsx" "useState<string>('')"
Check "첫 부서 자동선택"        "$base\dashboard\teams\ties\page.tsx" "divList[0]?.id"
Check "경기 시작시간 기록"      "$base\dashboard\teams\ties\page.tsx" "started_at: new Date()"

Write-Host "`n[03] teams/standings/page.tsx - BUG#1" -ForegroundColor Cyan
Check "all 제거 (빈 문자열)"    "$base\dashboard\teams\standings\page.tsx" "useState<string>('')"
Check "첫 부서 자동선택"        "$base\dashboard\teams\standings\page.tsx" "divList[0]?.id"

Write-Host "`n[04] courts/page.tsx - BUG#2" -ForegroundColor Cyan
Check "is_team_tie 플래그"      "$base\dashboard\courts\page.tsx" "is_team_tie"
Check "teamDivisionIds Set"     "$base\dashboard\courts\page.tsx" "teamDivisionIds"
Check "실제 division_id 사용"   "$base\dashboard\courts\page.tsx" "division_id: divisionId"
Check "시작시간 기록"           "$base\dashboard\courts\page.tsx" "started_at: new Date()"

Write-Host "`n[05] venue/manage/page.tsx - BUG#3" -ForegroundColor Cyan
Check "is_team_tie 플래그"      "$base\venue\manage\page.tsx" "is_team_tie"
Check "is_team_tie === true"    "$base\venue\manage\page.tsx" "is_team_tie === true"

Write-Host "`n[06] events/[id]/page.tsx - LIVE+접속로그" -ForegroundColor Cyan
Check "logAccess 함수"          "$base\events\[id]\page.tsx" "logAccess"
Check "access_logs insert"      "$base\events\[id]\page.tsx" "access_logs"
Check "LIVE animate-pulse"      "$base\events\[id]\page.tsx" "animate-pulse"

Write-Host "`n[07] dashboard/logs/page.tsx - 신규" -ForegroundColor Cyan
Check "파일 존재 + access_logs" "$base\dashboard\logs\page.tsx" "access_logs"
Check "byPage 통계"             "$base\dashboard\logs\page.tsx" "byPage"

Write-Host "`n[08] dashboard/report/page.tsx - 신규" -ForegroundColor Cyan
Check "CSV 내보내기"            "$base\dashboard\report\page.tsx" "downloadCSV"
Check "PDF 내보내기"            "$base\dashboard\report\page.tsx" "downloadPDF"
Check "jspdf import"            "$base\dashboard\report\page.tsx" "jspdf"

Write-Host "`n[09] dashboard/page.tsx - 진행률 바" -ForegroundColor Cyan
Check "progressPct 계산"        "$base\dashboard\page.tsx" "progressPct"
Check "진행률 바 width 스타일"  "$base\dashboard\page.tsx" "progressPct}%"
Check "ties in_progress 카운트" "$base\dashboard\page.tsx" "inProgressTies"

Write-Host "`n[10] pin/matches/page.tsx - 알림+종료시간" -ForegroundColor Cyan
Check "Web Push 알림"           "$base\pin\matches\page.tsx" "sendNotification"
Check "Notification API"        "$base\pin\matches\page.tsx" "Notification.requestPermission"
Check "ended_at 표시"           "$base\pin\matches\page.tsx" "ended_at"
Check "소요시간 계산"           "$base\pin\matches\page.tsx" "formatDuration"

Write-Host "`n========================================"
$total = $pass + $fail
Write-Host "결과: $pass / $total 통과" -ForegroundColor $(if ($fail -eq 0) {"Green"} else {"Yellow"})
if ($fail -gt 0) { Write-Host "=> FAIL 항목을 확인하세요." -ForegroundColor Yellow }
else             { Write-Host "=> 모든 수정사항 정상 적용!" -ForegroundColor Green }
Write-Host "========================================`n"
