// ============================================================
// 팀대회 tie 관리 페이지 (대시보드용)
// src/app/dashboard/teams/ties/page.tsx
// BUG#1 수정: selectedDiv 'all' 제거 → 항상 첫번째 부서 자동선택
// + 경기 시작/종료 시간 기록 및 표시
// ============================================================
'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { fetchTies, fetchRubbers, fetchEventTeamConfig, fetchRevealedLineups, fetchClubMembers, recordRubberScore, calculateStandings } from '@/lib/team-api';
import { supabase } from '@/lib/supabase';
import { getTieStatusLabel, getTieStatusColor, formatSetScore, getMajority } from '@/lib/team-utils';
import type { TieWithClubs, TieRubber, EventTeamConfig, TeamLineup, ClubMember } from '@/types/team';

export default function TiesPage() {
  const searchParams = useSearchParams();
  const eventId = searchParams.get('event_id') || '';
  const [config, setConfig] = useState<EventTeamConfig | null>(null);
  const [ties, setTies] = useState<TieWithClubs[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTie, setSelectedTie] = useState<TieWithClubs | null>(null);
  const [rubbers, setRubbers] = useState<TieRubber[]>([]);
  const [rubbersLoading, setRubbersLoading] = useState(false);
  const [tieLineups, setTieLineups] = useState<TeamLineup[]>([]);
  const [memberMap, setMemberMap] = useState<Record<string, ClubMember>>({});
  const [editingRubber, setEditingRubber] = useState<string | null>(null);
  const [scoreInput, setScoreInput] = useState({ set1a:'',set1b:'',set2a:'',set2b:'',set3a:'',set3b:'' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [copiedTieId, setCopiedTieId] = useState<string | null>(null);

  // BUG#1: 'all' 대신 '' 초기값, loadData에서 첫번째 부서로 자동설정
  const [divisions, setDivisions] = useState<any[]>([]);
  const [selectedDiv, setSelectedDiv] = useState<string>('');

  const [courtCount, setCourtCount] = useState(20);
  const [editingCourt, setEditingCourt] = useState<string | null>(null);
  const [courtInput, setCourtInput] = useState('');

  const loadData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      const [cfg, tieList, grpsRes, divsRes] = await Promise.all([
        fetchEventTeamConfig(eventId),
        fetchTies(eventId),
        supabase.from('groups').select('*').eq('event_id', eventId).order('division_id').order('group_num'),
        supabase.from('divisions').select('id, name, sort_order').eq('event_id', eventId).order('sort_order'),
      ]);
      setConfig(cfg);
      setTies(tieList);
      setGroups(grpsRes.data || []);
      const divList = divsRes.data || [];
      setDivisions(divList);
      // BUG#1: 첫번째 부서 자동선택 (현재 선택 없을 때만)
      setSelectedDiv(prev => prev || (divList[0]?.id ?? ''));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleSelectTie(tie: TieWithClubs) {
    if (selectedTie?.id === tie.id) { setSelectedTie(null); setRubbers([]); setTieLineups([]); return; }
    setSelectedTie(tie); setRubbersLoading(true); setEditingRubber(null);

    const [rubberData, lineupData, membersA, membersB] = await Promise.all([
      fetchRubbers(tie.id),
      fetchRevealedLineups(tie.id),
      tie.club_a_id ? fetchClubMembers(tie.club_a_id) : Promise.resolve([]),
      tie.club_b_id ? fetchClubMembers(tie.club_b_id) : Promise.resolve([]),
    ]);

    setRubbers(rubberData);
    setTieLineups(lineupData);
    const mm: Record<string, ClubMember> = {};
    membersA.forEach(m => { mm[m.id] = m; });
    membersB.forEach(m => { mm[m.id] = m; });
    setMemberMap(mm);
    setRubbersLoading(false);
  }

  function getMemberName(id: string|null|undefined): string { return id && memberMap[id] ? memberMap[id].name : '-'; }

  function startScoreEdit(rubber: TieRubber) {
    setEditingRubber(rubber.id); setSaveError('');
    setScoreInput({
      set1a: rubber.set1_a?.toString()||'', set1b: rubber.set1_b?.toString()||'',
      set2a: rubber.set2_a?.toString()||'', set2b: rubber.set2_b?.toString()||'',
      set3a: rubber.set3_a?.toString()||'', set3b: rubber.set3_b?.toString()||'',
    });
  }

  async function handleSaveScore(rubberId: string) {
    const {set1a,set1b,set2a,set2b,set3a,set3b} = scoreInput;
    if (!set1a||!set1b) { setSaveError('1세트 점수를 입력하세요.'); return; }
    setSaving(true); setSaveError('');
    try {
      const result = await recordRubberScore(rubberId, parseInt(set1a), parseInt(set1b),
        set2a?parseInt(set2a):null, set2b?parseInt(set2b):null, set3a?parseInt(set3a):null, set3b?parseInt(set3b):null);
      if (!result.success) { setSaveError(result.error||'저장 실패'); return; }
      setRubbers(await fetchRubbers(selectedTie!.id)); setEditingRubber(null); await loadData();
      try { await calculateStandings(eventId, selectedTie?.group_id||null); } catch {}
    } catch (err: any) { setSaveError(err.message||'저장 실패'); }
    finally { setSaving(false); }
  }

  async function handleCourtAssign(tieId: string, courtNum: number | null) {
    await supabase.from('ties').update({ court_number: courtNum }).eq('id', tieId);
    setEditingCourt(null); setCourtInput('');
    await loadData();
  }

  // 경기 시작 → started_at 기록
  async function handleStartTie(tieId: string) {
    await supabase.from('ties')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', tieId);
    await loadData();
  }

  function copyLineupUrl(tieId: string) {
    navigator.clipboard.writeText(`${window.location.origin}/lineup/${tieId}`);
    setCopiedTieId(tieId); setTimeout(() => setCopiedTieId(null), 2000);
  }

  // BUG#1: 'all' 분기 완전 제거 → selectedDiv로만 필터
  function getTiesByGroup() {
    if (groups.length === 0) {
      const rg: Record<string, TieWithClubs[]> = {};
      const filtered = selectedDiv ? ties.filter(t => (t as any).division_id === selectedDiv || !selectedDiv) : ties;
      filtered.forEach(t => { const k=t.round||'etc'; if(!rg[k])rg[k]=[]; rg[k].push(t); });
      return Object.entries(rg).map(([r,tl]) => ({ groupName:{full_league:'풀리그',group:'조별리그',round_of_16:'16강',quarter:'8강',semi:'4강',final:'결승',etc:'기타'}[r]||r, groupId:null, divisionId:null, ties:tl }));
    }

    const filteredGroups = selectedDiv
      ? groups.filter(g => g.division_id === selectedDiv)
      : groups;

    const result: {groupName:string;groupId:string|null;divisionId:string|null;ties:TieWithClubs[]}[] = [];
    for (const g of filteredGroups) {
      const gt = ties.filter(t => t.group_id === g.id);
      if (gt.length > 0) {
        const groupNumLabel = g.group_num ? String.fromCharCode(64 + g.group_num) + '조' : '';
        result.push({ groupName: g.group_label || groupNumLabel || g.group_name || g.id, groupId: g.id, divisionId: g.division_id, ties: gt });
      }
    }
    // 토너먼트(group_id 없는 ties)도 해당 division으로 필터
    const ug = ties.filter(t => !t.group_id && (!selectedDiv || (t as any).division_id === selectedDiv));
    if (ug.length > 0) result.push({ groupName: '토너먼트', groupId: null, divisionId: null, ties: ug });
    return result;
  }

  function formatTime(isoStr: string | null | undefined): string {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }

  function calcDuration(start: string | null | undefined, end: string | null | undefined): string {
    if (!start || !end) return '';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.round(ms / 60000);
    return `${mins}분`;
  }

  if (loading) return <div className="p-8 text-center text-gray-500">불러오는 중...</div>;
  if (ties.length===0) return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4"> 대전 관리</h1>
      <div className="bg-gray-50 rounded-lg border border-dashed p-8 text-center text-gray-400">타이가 없습니다. 먼저 조편성에서 타이를 생성하세요.</div>
    </div>
  );

  const tieGroups = getTiesByGroup();
  const setsPerRubber = config?.team_sets_per_rubber || 1;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold"> 대전 관리</h1>
        <span className="text-sm text-gray-500">전체 {ties.length}타이 · 완료 {ties.filter(t=>t.status==='completed').length}</span>
      </div>

      {/* Division 탭 - BUG#1: '전체' 버튼 제거 */}
      {divisions.length > 0 && (
        <div className="flex gap-1 overflow-x-auto">
          {divisions.map(d => (
            <button key={d.id} onClick={() => setSelectedDiv(d.id)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                selectedDiv === d.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>{d.name}</button>
          ))}
        </div>
      )}

      {tieGroups.map(group => (
        <div key={group.groupName} className="space-y-3">
          <h2 className="font-semibold text-lg">{group.groupName}</h2>
          {group.ties.map(tie => {
            const isSelected = selectedTie?.id===tie.id;
            const maj = getMajority(tie.rubber_count);
            const aWin = tie.club_a_rubbers_won>=maj && tie.status==='completed';
            const bWin = tie.club_b_rubbers_won>=maj && tie.status==='completed';
            const isEditingThisCourt = editingCourt === tie.id;
            const tieAny = tie as any;
            return (
              <div key={tie.id} className={`bg-white rounded-lg border overflow-hidden ${
                tie.status==='completed' ? 'border-green-300' : tie.status==='in_progress' ? 'border-red-300' : ''
              }`}>
                <div onClick={() => handleSelectTie(tie)} className={`p-4 cursor-pointer hover:bg-gray-50 transition ${
                  tie.status==='completed' ? 'bg-green-50/30' : tie.status==='in_progress' ? 'bg-red-50/20' : ''
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-xs text-gray-400">#{tie.tie_order}</span>
                      <span className={`font-semibold px-2 py-0.5 rounded ${
                        aWin ? 'bg-blue-100 text-blue-700' : bWin ? 'text-gray-400' : ''
                      }`}>
                        {aWin && ' '}{tie.club_a?.name||'TBD'}
                      </span>
                      <span className="text-gray-400 text-sm">vs</span>
                      <span className={`font-semibold px-2 py-0.5 rounded ${
                        bWin ? 'bg-blue-100 text-blue-700' : aWin ? 'text-gray-400' : ''
                      }`}>
                        {bWin && ' '}{tie.club_b?.name||'TBD'}
                      </span>
                      {tie.court_number && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">코트 {tie.court_number}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      {(tie.status==='completed'||tie.status==='in_progress') && (
                        <span className="text-lg font-bold">
                          <span className={aWin ? 'text-blue-700' : ''}>{tie.club_a_rubbers_won}</span>
                          <span className="text-gray-400 mx-1">-</span>
                          <span className={bWin ? 'text-blue-700' : ''}>{tie.club_b_rubbers_won}</span>
                        </span>
                      )}
                      <span className={`text-xs px-2 py-1 rounded-full ${getTieStatusColor(tie.status)}`}>{getTieStatusLabel(tie.status)}</span>
                      <span className="text-gray-400 text-sm">{isSelected?'▲':'▼'}</span>
                    </div>
                  </div>

                  {/* 시작/종료 시간 표시 */}
                  {(tieAny.started_at || tieAny.ended_at) && (
                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                      {tieAny.started_at && <span> 시작 {formatTime(tieAny.started_at)}</span>}
                      {tieAny.ended_at && <span> 종료 {formatTime(tieAny.ended_at)}</span>}
                      {tieAny.started_at && tieAny.ended_at && (
                        <span className="text-blue-500">⏱ {calcDuration(tieAny.started_at, tieAny.ended_at)}</span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    <span>{tie.club_a?.name?.slice(0,6)}: {tie.club_a_lineup_submitted?<span className="text-green-600 ml-1">제출완료</span>:<span className="text-orange-500 ml-1">미제출</span>}</span>
                    <span>{tie.club_b?.name?.slice(0,6)}: {tie.club_b_lineup_submitted?<span className="text-green-600 ml-1">제출완료</span>:<span className="text-orange-500 ml-1">미제출</span>}</span>
                    {tie.lineup_revealed && <span className="text-blue-600">라인업공개완료</span>}
                  </div>
                </div>

                {isSelected && (
                  <div className="border-t bg-gray-50 p-4 space-y-4">
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={e => {e.stopPropagation();copyLineupUrl(tie.id);}} className="text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-200">
                        {copiedTieId===tie.id?'복사됨':' 라인업 URL 복사'}</button>

                      {/* 시작 버튼 */}
                      {tie.status === 'pending' || tie.status === 'lineup_phase' ? (
                        <button onClick={e => { e.stopPropagation(); handleStartTie(tie.id); }}
                          className="text-xs bg-red-500 text-white px-3 py-1.5 rounded-lg hover:bg-red-600">
                          ▶ 경기 시작
                        </button>
                      ) : null}

                      {!isEditingThisCourt ? (
                        <button onClick={e => { e.stopPropagation(); setEditingCourt(tie.id); setCourtInput(tie.court_number?.toString()||''); }}
                          className="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-200">
                          {tie.court_number ? `코트 ${tie.court_number} (변경)` : ' 코트 배정'}</button>
                      ) : (
                        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                          <select value={courtInput} onChange={e => setCourtInput(e.target.value)} className="border rounded px-2 py-1 text-xs">
                            <option value="">미배정</option>
                            {Array.from({length:courtCount},(_,i)=>i+1).map(n => <option key={n} value={n}>코트 {n}</option>)}
                          </select>
                          <button onClick={() => handleCourtAssign(tie.id, courtInput ? parseInt(courtInput) : null)}
                            className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700">확인</button>
                          <button onClick={() => setEditingCourt(null)} className="text-xs text-gray-400 px-1">취소</button>
                        </div>
                      )}
                    </div>

                    {rubbersLoading ? (
                      <p className="text-center text-gray-400 text-sm">로딩...</p>
                    ) : (
                      <div className="space-y-3">
                        {rubbers.map(r => {
                          const isEditing = editingRubber === r.id;
                          const hasScore = r.set1_a !== null;
                          const rubberWinA = hasScore && (r.set1_a??0) > (r.set1_b??0);
                          const rubberWinB = hasScore && (r.set1_b??0) > (r.set1_a??0);
                          const laA = tieLineups.find(l => l.rubber_number===r.rubber_number && l.club_id===tie.club_a_id);
                          const laB = tieLineups.find(l => l.rubber_number===r.rubber_number && l.club_id===tie.club_b_id);
                          return (
                            <div key={r.id} className={`bg-white rounded-lg border p-3 ${rubberWinA?'border-blue-200':rubberWinB?'border-blue-200':''}`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold text-gray-600">러버 {r.rubber_number}</span>
                                {hasScore && <span className="text-xs text-gray-400">{rubberWinA?tie.club_a?.name:rubberWinB?tie.club_b?.name:''}승</span>}
                              </div>
                              {(laA||laB) && (
                                <div className="grid grid-cols-5 items-center gap-1 mb-3 text-xs">
                                  <div className={`col-span-2 text-right rounded p-1 ${rubberWinA ? 'bg-blue-50 text-blue-700 font-bold' : ''}`}>
                                    <div>{getMemberName(laA?.player1_id)} / {getMemberName(laA?.player2_id)}</div>
                                    <div className="text-gray-400">{tie.club_a?.name}</div>
                                  </div>
                                  <div className="text-center text-gray-400 font-bold">vs</div>
                                  <div className={`col-span-2 text-left rounded p-1 ${rubberWinB ? 'bg-blue-50 text-blue-700 font-bold' : ''}`}>
                                    <div>{getMemberName(laB?.player1_id)} / {getMemberName(laB?.player2_id)}</div>
                                    <div className="text-gray-400">{tie.club_b?.name}</div>
                                  </div>
                                </div>
                              )}
                              {!laA && !laB && tie.lineup_revealed && <p className="text-xs text-gray-400 mb-2">라인업 정보 없음</p>}
                              {hasScore && !isEditing && (
                                <div className="flex items-center justify-between">
                                  <div className="text-center flex-1"><div className="text-lg font-bold">{formatSetScore(r.set1_a,r.set1_b)}
                                    {r.set2_a!==null&&' / '+formatSetScore(r.set2_a,r.set2_b)}{r.set3_a!==null&&' / '+formatSetScore(r.set3_a,r.set3_b)}</div>
                                  </div>
                                  <button onClick={() => startScoreEdit(r)} className="text-xs text-gray-400 hover:text-blue-600 px-2">수정</button>
                                </div>
                              )}
                              {!hasScore && !isEditing && <button onClick={() => startScoreEdit(r)} className="w-full bg-blue-50 text-blue-700 py-2 rounded-lg text-sm hover:bg-blue-100">점수 입력</button>}
                              {isEditing && (
                                <div className="space-y-3 mt-2">
                                  <SetRow label="1세트" aVal={scoreInput.set1a} bVal={scoreInput.set1b} setA={v=>setScoreInput(p=>({...p,set1a:v}))} setB={v=>setScoreInput(p=>({...p,set1b:v}))} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  {setsPerRubber===3 && (<>
                                    <SetRow label="2세트" aVal={scoreInput.set2a} bVal={scoreInput.set2b} setA={v=>setScoreInput(p=>({...p,set2a:v}))} setB={v=>setScoreInput(p=>({...p,set2b:v}))} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                    <SetRow label="3세트" aVal={scoreInput.set3a} bVal={scoreInput.set3b} setA={v=>setScoreInput(p=>({...p,set3a:v}))} setB={v=>setScoreInput(p=>({...p,set3b:v}))} clubA={tie.club_a?.name} clubB={tie.club_b?.name} />
                                  </>)}
                                  {saveError && <p className="text-red-500 text-xs">{saveError}</p>}
                                  <div className="flex gap-2">
                                    <button onClick={() => {setEditingRubber(null);setSaveError('');}} className="flex-1 bg-gray-100 py-2 rounded-lg text-sm">취소</button>
                                    <button onClick={() => handleSaveScore(r.id)} disabled={saving} className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50">
                                      {saving?'저장...':'점수 확정'}</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SetRow({label,aVal,bVal,setA,setB,clubA,clubB}:{label:string;aVal:string;bVal:string;setA:(v:string)=>void;setB:(v:string)=>void;clubA?:string;clubB?:string}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-12">{label}</span>
      <div className="flex items-center gap-1 flex-1">
        <input type="number" min="0" max="7" value={aVal} onChange={e=>setA(e.target.value)} placeholder={clubA?.slice(0,4)} className="flex-1 border rounded px-2 py-1.5 text-center text-sm" />
        <span className="text-gray-400 text-xs">:</span>
        <input type="number" min="0" max="7" value={bVal} onChange={e=>setB(e.target.value)} placeholder={clubB?.slice(0,4)} className="flex-1 border rounded px-2 py-1.5 text-center text-sm" />
      </div>
    </div>
  );
}