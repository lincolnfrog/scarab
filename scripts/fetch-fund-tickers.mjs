#!/usr/bin/env node
// Refresh src/invest/fund-tickers.txt — the chaff population for "Ask the
// basket to cover this fund" (PRIVACY.md, "Anonymous add"): every ticker of a
// US-registered mutual fund share class, from the SEC's own list.
//
//   node scripts/fetch-fund-tickers.mjs            # fetches https://www.sec.gov/files/company_tickers_mf.json
//   node scripts/fetch-fund-tickers.mjs FILE.json  # from a copy already downloaded
//
// Source: EDGAR's "company_tickers_mf.json" — the Commission's mapping of
// investment-company series and classes to ticker symbols, published for
// EDGAR full-text search. A work of the United States government: public
// domain (17 U.S.C. §105), no licence needed, no attribution required (the
// header in the output names it anyway). The SEC asks automated clients to
// send a User-Agent naming who they are; fill in yours below or set
// SEC_USER_AGENT.
//
// Output: one symbol per line, upper case, sorted, deduplicated, after a
// header of `#` lines saying where and when it came from. Deterministic for a
// given input, so a rebuild from the same download gives the same bytes (the
// release manifest covers the bundled chunk).
import { readFileSync, writeFileSync } from 'node:fs'

const URL_ = 'https://www.sec.gov/files/company_tickers_mf.json'
const OUT = 'src/invest/fund-tickers.txt'
const SYMBOL = /^[A-Z][A-Z0-9]{0,9}$/

let text
let fetched
if (process.argv[2]) {
  text = readFileSync(process.argv[2], 'utf8')
  fetched = process.argv[3] ?? new Date().toISOString().slice(0, 10)
} else {
  const ua = process.env.SEC_USER_AGENT ?? 'Scarab household finance (github.com/lincolnfrog/scarab)'
  const r = await fetch(URL_, { headers: { 'user-agent': ua, accept: 'application/json' } })
  if (!r.ok) throw new Error(`${URL_} → HTTP ${r.status} (the SEC rate-limits and wants a User-Agent naming you: SEC_USER_AGENT="Name contact@example.com")`)
  text = await r.text()
  fetched = new Date().toISOString().slice(0, 10)
}
const data = JSON.parse(text)
const fields = data.fields
const iSym = Array.isArray(fields) ? fields.indexOf('symbol') : -1
if (iSym < 0 || !Array.isArray(data.data)) throw new Error('unexpected shape: expected { fields: [...,"symbol"], data: [[...]] }')
const symbols = new Set()
let skipped = 0
for (const row of data.data) {
  const s = String(row[iSym] ?? '').trim().toUpperCase()
  if (SYMBOL.test(s)) symbols.add(s)
  else skipped++
}
const sorted = [...symbols].sort()
const header = [
  '# US-registered mutual fund share-class tickers: the chaff population for "Ask the basket to cover this fund".',
  `# Source: ${URL_} (SEC EDGAR, "Investment Company Series and Class" tickers) — a US government work, public domain.`,
  `# Fetched ${fetched}: ${data.data.length} classes, ${sorted.length} distinct tickers (${skipped} rows without a usable one).`,
  '# Regenerate: node scripts/fetch-fund-tickers.mjs. One symbol per line; src/invest/fundTickers.ts reads it.',
]
writeFileSync(OUT, `${header.join('\n')}\n${sorted.join('\n')}\n`)
console.log(`wrote ${OUT}: ${sorted.length} tickers from ${data.data.length} classes (fetched ${fetched})`)
