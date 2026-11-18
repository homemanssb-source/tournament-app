import { createRequire } from 'module'
import { readFileSync } from 'fs'
const ROOT = 'C:/Users/homem/OneDrive/바탕 화면/tournament/phase2-frontend'
const require = createRequire(ROOT + '/package.json')
const { createClient } = require('@supabase/supabase-js')
let env = readFileSync(ROOT + '/.env.local', 'utf8'); if (env.charCodeAt(0) === 0xFEFF) env = env.slice(1)
const E = {}
env.split(/\r?\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); if (i < 1) return; E[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '') })
export const svc = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
export const appA = createClient(E.APP_A_SUPABASE_URL, E.APP_A_ANON_KEY, { auth: { persistSession: false } })
export const must = (r, label) => { if (r.error) throw new Error(label + ': ' + r.error.message); return r.data }
