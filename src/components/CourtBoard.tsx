'use client'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

interface CourtMatch {
  id: string; match_num: string; court: string; court_order: number
  stage: string; round: string; status: string; score: string | null
  division_name: string
  team_a_name: string; team_b_name: string
  team_a_id: string; team_b_id: string
  winner_team_id: string | null
  is_team_tie?: boolean
}

export default function CourtBoard({ eventId }: { eventId: string }) {
  const [matches, setMatches] = useState<CourtMatch[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  const loadData = useCallback(async () => {
    const { data: matchData } = await supabase.from('v_matches_with_teams').select('*')
      .eq('event_id', eventId).not('court', 'is', null).order('court').order('court_order')
    const indivMatches: CourtMatch[] = ((matchData as any[]) || [])
      .filter(m => m.score !== 'BYE').map(m => ({ ...m, is_team_tie: false }))
    const { data: tieData } = await supabase.from('ties')
      .select('*, club_a:clubs!ties_club_a_id_fkey(name), club_b:clubs!ties_club_b_id_fkey(name)')
      .eq('event_id', eventId).not('court_number', 'is', null).order('court_number').order('tie_order')
    const sMap: Record<string, string> = { pending: 'PENDING', lineup_phase: 'PENDING', in_progress: 'IN_PROGRESS', completed: 'FINISHED' }
    const tieMatches: CourtMatch[] = ((tieData as any[]) || []).filter(t => !t.is_bye).map(t => ({
      id: 'tie_' + t.id, match_num: 'T#' + t.tie_order, court: '\uCF54\uD2B8 ' + t.court_number,
      court_order: 100 + (t.tie_order || 0), stage: 'TEAM', round: t.round || 'group',
      status: sMap[t.status] || 'PENDING',
      score: (t.status === 'completed' || t.status === 'in_progress') ? t.club_a_rubbers_won + '-' + t.club_b_rubbers_won : null,
      division_name: '\uB2E8\uCCB4\uC804', team_a_name: t.club_a?.name || 'TBD', team_b_name: t.club_b?.name || 'TBD',
      team_a_id: t.club_a_id || '', team_b_id: t.club_b_id || '', winner_team_id: t.winning_club_id || null, is_team_tie: true,
    }))
    setMatches([...indivMatches, ...tieMatches]); setLoading(false); setLastUpdate(new Date())
  }, [eventId])

  useEffect(() => { loadData(); const i = setInterval(loadData, 15000); return () => clearInterval(i) }, [loadData])

  const byCourt = new Map<string, CourtMatch[]>()
  for (const m of matches) { if (!byCourt.has(m.court)) byCourt.set(m.court, []); byCourt.get(m.court)!.push(m) }
  const courts = Array.from(byCourt.keys()).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, '')) || 0; const nb = parseInt(b.replace(/\D/g, '')) || 0; return na - nb
  })

  if (loading) return <p className="text-center py-10 text-stone-400">{'\uBD88\uB7EC\uC624\uB294 \uC911...'}</p>
  if (!courts.length) return <p className="text-center py-10 text-stone-400">{'\uC544\uC9C1 \uCF54\uD2B8 \uBC30\uC815\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.'}</p>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-lg">{'\uD83C\uDFBE \uCF54\uD2B8 \uD604\uD669'}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-400">{'\uD83D\uDD04 '}{lastUpdate.toLocaleTimeString('ko-KR')}{' \uC5C5\uB370\uC774\uD2B8'}</span>
          <button onClick={loadData} className="text-xs px-2 py-1 bg-stone-100 rounded-lg hover:bg-stone-200">{'\uC0C8\uB85C\uACE0\uCE68'}</button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {courts.map(court => {
          const cm = (byCourt.get(court) || []).sort((a, b) => (a.court_order || 0) - (b.court_order || 0))
          const ci = cm.findIndex(m => m.status === 'IN_PROGRESS')
          const pi = cm.findIndex(m => m.status === 'PENDING')
          const ai = ci >= 0 ? ci : pi
          const fc = cm.filter(m => m.status === 'FINISHED').length
          const tc = cm.length
          const cur = ai >= 0 ? cm[ai] : null
          const w1 = ai >= 0 && ai + 1 < cm.length ? cm[ai + 1] : null
          const w2 = ai >= 0 && ai + 2 < cm.length ? cm[ai + 2] : null
          const allDone = fc === tc
          return (
            <div key={court} className="bg-white rounded-xl border overflow-hidden">
              <div className={'px-4 py-2.5 font-bold text-sm flex items-center justify-between ' + (allDone ? 'bg-stone-400 text-white' : 'bg-[#2d5016] text-white')}>
                <span>{court}</span>
                <span className="text-white/70 text-xs font-normal">{fc}/{tc}{' \uC644\uB8CC'}</span>
              </div>
              <div className="p-3 space-y-2">
                {allDone ? (
                  <div className="text-center py-4 text-stone-400"><div className="text-2xl mb-1">{'\u2705'}</div><div className="text-sm">{'\uBAA8\uB4E0 \uACBD\uAE30 \uC644\uB8CC'}</div></div>
                ) : (<>
                  {cur && <CourtSlot label={'\uD83D\uDD34 \uD604\uC7AC \uACBD\uAE30'} labelColor="bg-red-50 text-red-700 border-red-200" match={cur} />}
                  {w1 && <CourtSlot label={'\uD83D\uDFE1 \uB2E4\uC74C \uB300\uAE30'} labelColor="bg-amber-50 text-amber-700 border-amber-200" match={w1} />}
                  {w2 && <CourtSlot label={'\uD83D\uDFE2 \uB300\uAE30 2'} labelColor="bg-green-50 text-green-700 border-green-200" match={w2} />}
                  {ai >= 0 && ai + 3 < cm.length && <RemainingMatches matches={cm.slice(ai + 3).filter(m => m.status !== 'FINISHED')} />}
                </>)}
                {fc > 0 && <FinishedMatches matches={cm.filter(m => m.status === 'FINISHED')} />}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
function CourtSlot({ label, labelColor, match }: { label: string; labelColor: string; match: CourtMatch }) {
  const isTeam = match.is_team_tie
  return (
    <div className={'rounded-lg border p-2.5 ' + labelColor}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-bold">{label}</span>
        <span className="text-xs opacity-70">#{match.court_order > 100 ? match.match_num : match.court_order}{' \u00B7 '}{match.round}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm truncate">{match.team_a_name || 'TBD'}</div>
          <div className="text-xs opacity-60">vs</div>
          <div className="font-bold text-sm truncate">{match.team_b_name || 'TBD'}</div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className={'text-xs font-medium px-2 py-0.5 rounded-full ' + (isTeam ? 'bg-blue-100 text-blue-700' : 'bg-white/50')}>
            {isTeam ? '\uD83D\uDCCB \uB2E8\uCCB4\uC804' : match.division_name}
          </div>
          {match.score && <div className={'text-sm font-bold mt-1 ' + (isTeam ? 'text-blue-700' : '')}>{match.score}</div>}
        </div>
      </div>
    </div>
  )
}

function RemainingMatches({ matches }: { matches: CourtMatch[] }) {
  const [open, setOpen] = useState(false)
  if (!matches.length) return null
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="text-xs text-stone-400 hover:text-stone-600 w-full text-left py-1">
        {open ? '\u25BC' : '\u25B6'}{' \uC774\uD6C4 \uB300\uAE30 '}{matches.length}{'\uACBD\uAE30'}
      </button>
      {open && <div className="space-y-1 ml-3">{matches.map(m => (
        <div key={m.id} className="text-xs py-1 border-b border-stone-50 last:border-0">
          <span className="text-stone-400">#{m.is_team_tie ? m.match_num : m.court_order}</span>{' '}
          {m.is_team_tie && <span className="text-blue-600 mr-1">[\uB2E8\uCCB4]</span>}
          <span className="font-medium">{m.team_a_name}</span>
          <span className="text-stone-300"> vs </span>
          <span className="font-medium">{m.team_b_name}</span>
          {!m.is_team_tie && <span className="text-stone-400 ml-1">({m.division_name})</span>}
        </div>
      ))}</div>}
    </div>
  )
}

function FinishedMatches({ matches }: { matches: CourtMatch[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-stone-100 pt-2 mt-2">
      <button onClick={() => setOpen(!open)} className="text-xs text-stone-400 hover:text-stone-600 w-full text-left">
        {open ? '\u25BC' : '\u25B6'}{' \uC644\uB8CC '}{matches.length}{'\uACBD\uAE30'}
      </button>
      {open && <div className="space-y-1 mt-1 ml-3">{matches.map(m => (
        <div key={m.id} className="text-xs py-1 text-stone-400 border-b border-stone-50 last:border-0">
          <span>#{m.is_team_tie ? m.match_num : m.court_order}</span>{' '}
          {m.is_team_tie && <span className="text-blue-500 mr-1">[\uB2E8\uCCB4]</span>}
          <span>{m.team_a_name} vs {m.team_b_name}</span>
          {m.score && <span className={'font-bold ml-1 ' + (m.is_team_tie ? 'text-blue-600' : 'text-tennis-600')}>{m.score}</span>}
        </div>
      ))}</div>}
    </div>
  )
}