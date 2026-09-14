'use client'
// ============================================================
// 운영자 관리 (메인 관리자 전용)
// src/app/dashboard/operators/page.tsx
//
// 대회별 운영자 계정을 만들고 담당 대회를 배정한다.
// 운영자는 로그인 시 배정된 대회만 대시보드에 보인다(화면 격리).
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Operator { id: string; email: string; display_name: string; event_ids: string[]; created_at: string }
interface EventLite { id: string; name: string; date: string }

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token || ''
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

export default function OperatorsPage() {
  const [operators, setOperators] = useState<Operator[]>([])
  const [events, setEvents] = useState<EventLite[]>([])
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [msg, setMsg] = useState('')

  // 신규 운영자 폼
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [newEventIds, setNewEventIds] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const [opRes, evRes] = await Promise.all([
        fetch('/api/admin/operators', { headers: await authHeaders() }),
        supabase.from('events').select('id, name, date').order('date', { ascending: false }),
      ])
      if (opRes.status === 403) { setForbidden(true); return }
      const j = await opRes.json().catch(() => ({}))
      if (!opRes.ok) { setMsg('❌ ' + (j.error || opRes.statusText)); return }
      setOperators(j.operators || [])
      setEvents((evRes.data || []) as EventLite[])
    } finally { setLoading(false) }
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
  }

  async function createOperator() {
    if (!email.trim() || !email.includes('@')) { setMsg('❌ 올바른 이메일을 입력하세요.'); return }
    if (password.length < 6) { setMsg('❌ 비밀번호는 6자 이상이어야 합니다.'); return }
    if (!name.trim()) { setMsg('❌ 운영자 이름을 입력하세요.'); return }
    setCreating(true); setMsg('')
    try {
      const res = await fetch('/api/admin/operators', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ email: email.trim(), password, display_name: name.trim(), event_ids: newEventIds }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg('❌ ' + (j.error || res.statusText)); return }
      setMsg(`✅ 운영자 '${name.trim()}' 계정이 생성되었습니다. (${email.trim()})`)
      setEmail(''); setPassword(''); setName(''); setNewEventIds([])
      await load()
    } finally { setCreating(false) }
  }

  async function saveEvents(op: Operator, nextIds: string[]) {
    setBusyId(op.id); setMsg('')
    try {
      const res = await fetch('/api/admin/operators', {
        method: 'PATCH', headers: await authHeaders(),
        body: JSON.stringify({ id: op.id, event_ids: nextIds }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg('❌ ' + (j.error || res.statusText)); return }
      setOperators(prev => prev.map(o => o.id === op.id ? { ...o, event_ids: nextIds } : o))
    } finally { setBusyId(null) }
  }

  async function resetPassword(op: Operator) {
    const pw = prompt(`${op.display_name || op.email} 의 새 비밀번호 (6자 이상)`)
    if (pw === null) return
    if (pw.length < 6) { setMsg('❌ 비밀번호는 6자 이상이어야 합니다.'); return }
    setBusyId(op.id); setMsg('')
    try {
      const res = await fetch('/api/admin/operators', {
        method: 'PATCH', headers: await authHeaders(),
        body: JSON.stringify({ id: op.id, password: pw }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg('❌ ' + (j.error || res.statusText)); return }
      setMsg('✅ 비밀번호가 변경되었습니다.')
    } finally { setBusyId(null) }
  }

  async function removeOperator(op: Operator) {
    if (!confirm(`운영자 '${op.display_name || op.email}' 계정을 삭제하시겠습니까?\n이 계정으로는 더 이상 로그인할 수 없습니다.`)) return
    setBusyId(op.id); setMsg('')
    try {
      const res = await fetch('/api/admin/operators?id=' + encodeURIComponent(op.id), {
        method: 'DELETE', headers: await authHeaders(),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg('❌ ' + (j.error || res.statusText)); return }
      setMsg('✅ 삭제되었습니다.')
      setOperators(prev => prev.filter(o => o.id !== op.id))
    } finally { setBusyId(null) }
  }

  const eventName = (id: string) => events.find(e => e.id === id)?.name || id.slice(0, 8)

  if (loading) return <p className="text-stone-400">불러오는 중...</p>
  if (forbidden) return (
    <div className="max-w-2xl mx-auto bg-white rounded-xl border p-6 text-center">
      <div className="text-3xl mb-2">🔒</div>
      <p className="font-semibold">메인 관리자만 접근할 수 있습니다.</p>
      <p className="text-xs text-stone-400 mt-1">운영자 계정 생성·배정은 메인 관리자에게 요청하세요.</p>
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">👤 운영자 관리</h1>
        <p className="text-sm text-stone-500 mt-1">
          대회별 운영자 계정을 만들고 담당 대회를 배정합니다. 운영자는 로그인하면 <b>배정된 대회만</b> 보입니다.
        </p>
      </div>

      {msg && (
        <p className={`text-sm rounded-lg px-3 py-2 ${msg.startsWith('✅') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg}</p>
      )}

      {/* 신규 운영자 */}
      <div className="bg-white rounded-xl border p-5 space-y-3">
        <h2 className="font-bold">➕ 운영자 추가</h2>
        <div className="grid sm:grid-cols-3 gap-2">
          <input type="email" placeholder="이메일 (로그인 ID)" value={email} onChange={e => setEmail(e.target.value)}
            className="border border-stone-300 rounded-lg px-3 py-2 text-sm" autoComplete="off" />
          <input type="password" placeholder="비밀번호 (6자 이상)" value={password} onChange={e => setPassword(e.target.value)}
            className="border border-stone-300 rounded-lg px-3 py-2 text-sm" autoComplete="new-password" />
          <input type="text" placeholder="운영자 이름 (예: ○○협회)" value={name} onChange={e => setName(e.target.value)}
            className="border border-stone-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <p className="text-xs text-stone-500 mb-1">담당 대회 (나중에 바꿀 수 있어요)</p>
          <div className="flex flex-wrap gap-2">
            {events.length === 0 && <span className="text-xs text-stone-400">대회가 없습니다.</span>}
            {events.map(ev => (
              <label key={ev.id} className={`text-xs border rounded-full px-3 py-1 cursor-pointer select-none ${
                newEventIds.includes(ev.id) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-stone-600 border-stone-300 hover:border-blue-300'}`}>
                <input type="checkbox" className="hidden" checked={newEventIds.includes(ev.id)}
                  onChange={() => setNewEventIds(toggle(newEventIds, ev.id))} />
                {ev.name} <span className="opacity-60">({ev.date})</span>
              </label>
            ))}
          </div>
        </div>
        <button onClick={createOperator} disabled={creating}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {creating ? '생성 중...' : '운영자 계정 생성'}
        </button>
      </div>

      {/* 운영자 목록 */}
      <div className="bg-white rounded-xl border p-5 space-y-3">
        <h2 className="font-bold">운영자 목록 <span className="text-xs text-stone-400 font-normal">({operators.length}명)</span></h2>
        {operators.length === 0 && <p className="text-sm text-stone-400">아직 운영자가 없습니다. 위에서 추가하세요.</p>}
        {operators.map(op => (
          <div key={op.id} className="border border-stone-200 rounded-xl p-4 space-y-2">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="font-semibold text-sm">{op.display_name || '(이름 없음)'}</div>
                <div className="text-xs text-stone-400 truncate">{op.email}</div>
              </div>
              <div className="flex gap-3 text-xs">
                <button onClick={() => resetPassword(op)} disabled={busyId === op.id} className="text-blue-600 hover:underline disabled:opacity-50">비밀번호 재설정</button>
                <button onClick={() => removeOperator(op)} disabled={busyId === op.id} className="text-stone-400 hover:text-red-500 disabled:opacity-50">삭제</button>
              </div>
            </div>
            <div>
              <p className="text-xs text-stone-500 mb-1">
                담당 대회 {op.event_ids.length === 0 && <span className="text-amber-600">— 배정된 대회가 없어 로그인해도 볼 대회가 없습니다</span>}
              </p>
              <div className="flex flex-wrap gap-2">
                {events.map(ev => {
                  const on = op.event_ids.includes(ev.id)
                  return (
                    <label key={ev.id} className={`text-xs border rounded-full px-3 py-1 cursor-pointer select-none ${busyId === op.id ? 'opacity-50' : ''} ${
                      on ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-stone-600 border-stone-300 hover:border-blue-300'}`}>
                      <input type="checkbox" className="hidden" checked={on} disabled={busyId === op.id}
                        onChange={() => saveEvents(op, toggle(op.event_ids, ev.id))} />
                      {ev.name}
                    </label>
                  )
                })}
              </div>
              {op.event_ids.some(id => !events.find(e => e.id === id)) && (
                <p className="text-[11px] text-stone-400 mt-1">* 목록에 없는 대회 배정: {op.event_ids.filter(id => !events.find(e => e.id === id)).map(eventName).join(', ')}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-stone-400">
        * 화면 격리 방식입니다. 운영자에겐 배정된 대회만 보이며 실수로 다른 대회를 건드리는 것을 막습니다.
      </p>
    </div>
  )
}
