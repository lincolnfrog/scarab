import type { DbLike } from '../engine/db'
import { putPmmsRate } from '../engine/digest'

/**
 * Freddie Mac PMMS weekly average 30-year fixed rate, via FRED's keyless
 * fredgraph.csv (freddiemac.com itself 403s datacenter IPs — a scar for the
 * table in DESIGN.md). Fetched at most once per day (app_meta flag), parsed
 * defensively, cached via the engine so local/ZK snapshots carry the
 * last-known rate.
 */
const PMMS_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US'

export function parsePmmsCsv(text: string): { on: string; rateMicro: number } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i > 0; i--) {
    const cells = lines[i]!.split(',')
    const rate = Number(cells[1])
    if (!Number.isFinite(rate) || rate <= 0 || rate > 25) continue
    const raw = cells[0]?.trim() ?? ''
    let on: string | null = null
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) on = raw // FRED: ISO already
    else {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw) // PMMS-style fallback
      if (m) on = `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
    }
    if (!on) continue
    return { on, rateMicro: Math.round(rate * 10_000) }
  }
  return null
}

export async function ensurePmmsRate(db: DbLike, f: typeof fetch = fetch): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10)
  const flag = `fetched:pmms:${today}`
  if (db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get(flag)) return []
  try {
    const r = await f(PMMS_URL, { headers: { 'user-agent': 'Mozilla/5.0 (scarab household finance)' } })
    if (!r.ok) return [`mortgage rates: PMMS HTTP ${r.status}`]
    const parsed = parsePmmsCsv(await r.text())
    if (!parsed) return ['mortgage rates: PMMS CSV had no parsable row']
    putPmmsRate(db, parsed.on, parsed.rateMicro)
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, datetime('now')) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(flag)
    return []
  } catch (e) {
    return [`mortgage rates: ${e instanceof Error ? e.message : 'fetch failed'}`]
  }
}
