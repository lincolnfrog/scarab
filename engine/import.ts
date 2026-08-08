import type { DbLike } from './db'
import { sha1Hex } from './hash'
import { parseMoney, type Cents } from '../shared/money'

export type ParsedRow = {
  postedOn: string // ISO yyyy-mm-dd
  amountCents: Cents // signed: + inflow, - outflow
  description: string
  fitid?: string // OFX transaction id, when the format provides one
}

export type ParseResult = { format: 'ofx' | 'csv-wf' | 'csv-generic'; rows: ParsedRow[] }

/* ---------------- parsing ---------------- */

function isoFromMDY(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim())
  if (!m) return null
  return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

function isoFromAny(s: string): string | null {
  const t = s.trim()
  const mdy = isoFromMDY(t)
  if (mdy) return mdy
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  return null
}

/** Split one CSV line honoring double quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** Wells Fargo CSV export: no header; "MM/DD/YYYY","amount","*","","description" */
function parseCsvWellsFargo(lines: string[][]): ParsedRow[] | null {
  if (lines.length === 0) return null
  const looksWF = lines.every((f) => f.length === 5 && isoFromMDY(f[0]!) !== null && f[2] === '*')
  if (!looksWF) return null
  return lines.map((f) => ({
    postedOn: isoFromMDY(f[0]!)!,
    amountCents: parseMoney(f[1]!),
    description: f[4]!.trim(),
  }))
}

/** Any CSV with a header row naming date/description/amount (or debit+credit) columns. */
function parseCsvGeneric(lines: string[][]): ParsedRow[] | null {
  if (lines.length < 2) return null
  const header = lines[0]!.map((h) => h.trim().toLowerCase())
  const find = (re: RegExp) => header.findIndex((h) => re.test(h))
  const iDate = find(/^(posting |posted |transaction )?date$|^posted$/)
  const iDesc = find(/desc|payee|merchant|^name$|^memo$/)
  const iAmount = find(/^amount$/)
  const iDebit = find(/debit/)
  const iCredit = find(/credit/)
  if (iDate < 0 || iDesc < 0 || (iAmount < 0 && (iDebit < 0 || iCredit < 0))) return null
  const rows: ParsedRow[] = []
  for (const f of lines.slice(1)) {
    const date = isoFromAny(f[iDate] ?? '')
    if (!date) continue // tolerate stray footer/blank rows
    let cents: Cents
    if (iAmount >= 0) cents = parseMoney(f[iAmount]!)
    else {
      // Citi (and others) report card payments as *negative* credits; charges
      // as positive debits. Use magnitudes so both conventions land correctly:
      // charges negative, payments/refunds positive.
      const debit = f[iDebit]?.trim() ? Math.abs(parseMoney(f[iDebit]!)) : 0
      const credit = f[iCredit]?.trim() ? Math.abs(parseMoney(f[iCredit]!)) : 0
      cents = credit - debit
    }
    rows.push({ postedOn: date, amountCents: cents, description: (f[iDesc] ?? '').trim() })
  }
  return rows.length > 0 ? rows : null
}

/** OFX/QFX statement download (SGML or XML flavored). */
function parseOfx(text: string): ParsedRow[] {
  const rows: ParsedRow[] = []
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi) ?? []
  for (const b of blocks) {
    const field = (tag: string) => {
      const m = new RegExp(`<${tag}>([^\\r\\n<]*)`, 'i').exec(b)
      return m ? m[1]!.trim() : ''
    }
    const dt = /(\d{8})/.exec(field('DTPOSTED'))?.[1]
    const amt = field('TRNAMT')
    if (!dt || !amt) continue
    const name = field('NAME')
    const memo = field('MEMO')
    rows.push({
      postedOn: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
      amountCents: parseMoney(amt),
      description: memo && memo !== name ? (name ? `${name} ${memo}` : memo) : name,
      fitid: field('FITID') || undefined,
    })
  }
  return rows
}

export function parseStatement(text: string): ParseResult {
  if (/<OFX|<STMTTRN/i.test(text)) {
    const rows = parseOfx(text)
    if (rows.length === 0) throw new Error('OFX file contained no transactions')
    return { format: 'ofx', rows }
  }
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map(splitCsvLine)
  const wf = parseCsvWellsFargo(lines)
  if (wf) return { format: 'csv-wf', rows: wf }
  const generic = parseCsvGeneric(lines)
  if (generic) return { format: 'csv-generic', rows: generic }
  throw new Error(
    'Unrecognized file. Expected an OFX/QFX download, a Wells Fargo CSV, or a CSV with Date/Description/Amount headers.',
  )
}

/* ---------------- dedupe ---------------- */

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim()

/**
 * Dedupe key. OFX gives a real per-account transaction id (FITID). For CSV we
 * hash (date, amount, normalized description) and add an ordinal so that two
 * genuinely identical purchases on the same day survive, while re-importing an
 * overlapping export skips every row it already delivered.
 */
export function dedupeHashes(rows: ParsedRow[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    if (r.fitid) return `fitid:${r.fitid}`
    const base = sha1Hex(`${r.postedOn}|${r.amountCents}|${norm(r.description)}`).slice(0, 20)
    const ordinal = seen.get(base) ?? 0
    seen.set(base, ordinal + 1)
    return `${base}#${ordinal}`
  })
}

/* ---------------- categorizer ---------------- */

export type Rule = { id: number; pattern: string; category_id: number; priority: number }

/** Longest / highest-priority matching pattern wins; substring, case-insensitive. */
export function categorize(description: string, rules: Rule[]): Rule | null {
  const d = norm(description)
  let best: Rule | null = null
  for (const r of rules) {
    if (!d.includes(r.pattern.toUpperCase())) continue
    if (
      !best ||
      r.priority > best.priority ||
      (r.priority === best.priority && r.pattern.length > best.pattern.length)
    )
      best = r
  }
  return best
}

/* ---------------- the import itself ---------------- */

export function importStatement(
  db: DbLike,
  args: { accountId: number; filename: string; content: string; importedBy: string },
): { format: string; rowsTotal: number; imported: number; skipped: number; transfersFiled: number } {
  const { format, rows } = parseStatement(args.content)
  const hashes = dedupeHashes(rows)
  const rules = db.prepare('SELECT id, pattern, category_id, priority FROM rules').all() as Rule[]

  const existing = new Set(
    (
      db.prepare('SELECT dedupe_hash FROM transactions WHERE account_id = ?').all(args.accountId) as {
        dedupe_hash: string
      }[]
    ).map((r) => r.dedupe_hash),
  )

  let imported = 0
  db.transaction(() => {
    const imp = db
      .prepare(
        `INSERT INTO imports (account_id, filename, format, rows_total, rows_imported, rows_skipped, imported_by)
         VALUES (?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(args.accountId, args.filename, format, rows.length, args.importedBy)
    const insert = db.prepare(
      `INSERT INTO transactions
         (account_id, posted_on, amount_cents, description, category_id, categorized_by, import_id, dedupe_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    rows.forEach((r, i) => {
      if (existing.has(hashes[i]!)) return
      const rule = categorize(r.description, rules)
      insert.run(
        args.accountId,
        r.postedOn,
        r.amountCents,
        r.description,
        rule?.category_id ?? null,
        rule ? `rule:${rule.id}` : null,
        imp.lastInsertRowid,
        hashes[i]!,
      )
      imported++
    })
    db.prepare('UPDATE imports SET rows_imported = ?, rows_skipped = ? WHERE id = ?').run(
      imported,
      rows.length - imported,
      imp.lastInsertRowid,
    )
  })()

  const transfersFiled = detectTransfers(db)
  return { format, rowsTotal: rows.length, imported, skipped: rows.length - imported, transfersFiled }
}

/* ---------------- transfer pair detection ---------------- */

/**
 * A debit in one account and an equal-and-opposite credit in another within a
 * few days is almost certainly money moving between your own accounts, not
 * income or spending. Pair them greedily (nearest dates first, one-to-one) and
 * file both sides as Transfer. Manual categorizations are never overridden;
 * runs at boot and after every import, so it is idempotent.
 */
export function detectTransfers(db: DbLike, windowDays = 3): number {
  const transfer = db.prepare("SELECT id FROM categories WHERE kind = 'transfer' ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined
  if (!transfer) return 0

  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, t.posted_on, t.amount_cents,
              (cat.kind = 'transfer') AS is_transfer
       FROM transactions t
       LEFT JOIN categories cat ON cat.id = t.category_id
       WHERE t.amount_cents != 0 AND (t.categorized_by IS NULL OR t.categorized_by NOT IN ('manual'))
       ORDER BY t.posted_on, t.id`,
    )
    .all() as { id: number; account_id: number; posted_on: string; amount_cents: number; is_transfer: 0 | 1 | null }[]

  const day = (iso: string) => Math.floor(Date.parse(iso) / 86400000)
  const credits = new Map<number, typeof rows>() // abs amount -> unmatched credits
  for (const r of rows) if (r.amount_cents > 0) {
    const list = credits.get(r.amount_cents) ?? []
    list.push(r)
    credits.set(r.amount_cents, list)
  }

  const pairs: [typeof rows[number], typeof rows[number]][] = []
  for (const debit of rows) {
    if (debit.amount_cents >= 0) continue
    const candidates = credits.get(-debit.amount_cents)
    if (!candidates?.length) continue
    let bestIdx = -1
    let bestDist = windowDays + 1
    candidates.forEach((cr, i) => {
      if (cr.account_id === debit.account_id) return
      const dist = Math.abs(day(cr.posted_on) - day(debit.posted_on))
      if (dist <= windowDays && dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    })
    if (bestIdx >= 0) {
      pairs.push([debit, candidates[bestIdx]!])
      candidates.splice(bestIdx, 1)
    }
  }

  const mark = db.prepare("UPDATE transactions SET category_id = ?, categorized_by = 'auto:transfer' WHERE id = ?")
  let marked = 0
  db.transaction(() => {
    for (const [a, b] of pairs)
      for (const side of [a, b])
        if (!side.is_transfer) {
          mark.run(transfer.id, side.id)
          marked++
        }
  })()
  return pairs.length > 0 ? marked : 0
}

/* ---------------- merchant extraction ---------------- */

const BANK_PREFIX =
  /^(?:(?:PURCHASE|POS PURCHASE|CHECK CRD PURCHASE|DEBIT CARD PURCHASE|RECURRING PAYMENT|PAYMENT|ATM WITHDRAWAL|WITHDRAWAL|CHECKCARD)\s+(?:AUTHORIZED\s+)?(?:ON\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+)/

/**
 * Pull the actual merchant out of bank statement boilerplate:
 * "PURCHASE AUTHORIZED ON 08/02 TRADER JOE'S #202 SANTA BARBARA CA S4662… CARD 2841"
 * → "TRADER JOE'S". Used to auto-derive categorizer rules.
 */
export function extractMerchant(desc: string): string {
  let d = norm(desc).replace(BANK_PREFIX, '')
  d = d.replace(/\bCARD\s+\d{4}\b.*$/, '').trim()
  const out: string[] = []
  for (const t of d.split(' ')) {
    if (/^#/.test(t)) break // store number
    if (/^[A-Z]?\d{5,}/.test(t)) break // reference codes: S466208…, 012345…
    if (/^\d{3}-\d{3}/.test(t)) break // phone numbers
    if (/^\d{1,2}\/\d{1,2}/.test(t)) break // stray dates
    if (/^X{4,}/.test(t)) break // masked digits
    out.push(t)
    if (out.length >= 4) break
  }
  return out.join(' ')
}
