import { describe, expect, it } from 'vitest'
import { categorize, dedupeHashes, importStatement, parseStatement, splitCsvLine } from './import'
import { openDb } from './migrations'

const WF_CSV = `"08/01/2026","-3418.00","*","","MR. COOPER MORTGAGE PYMT"
"08/01/2026","-48.75","*","","LA SUPER-RICA TAQUERIA SANTA BARBARA CA"
"08/02/2026","-64.19","*","","AMAZON MKTPL*RT4Y2 AMZN.COM/BILL WA"
"08/03/2026","-12000.00","*","","ONLINE TRANSFER TO WEALTHFRONT EDI PYMNTS"
"08/04/2026","11918.00","*","","ACME CORP PAYROLL 260804"
"08/04/2026","-6.50","*","","BLUE OWL COFFEE GOLETA CA"
"08/04/2026","-6.50","*","","BLUE OWL COFFEE GOLETA CA"`

const GENERIC_CSV = `Date,Description,Amount
2026-08-01,"Whole Foods Market #123",-214.03
08/02/2026,PG&E UTILITY PMT,"-187.22"
2026-08-03,Sole Prop Consulting deposit,"6,250.00"`

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260801120000[0:GMT]
<TRNAMT>-3418.00
<FITID>2026080101
<NAME>MR COOPER
<MEMO>MORTGAGE PAYMENT
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260804
<TRNAMT>11918.00
<FITID>2026080402
<NAME>ACME CORP PAYROLL
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

describe('splitCsvLine', () => {
  it('honors quotes and embedded commas', () => {
    expect(splitCsvLine('"a,b",c,"d""e"')).toEqual(['a,b', 'c', 'd"e'])
  })
})

describe('parseStatement', () => {
  it('detects Wells Fargo CSV (no header, 5 columns, star)', () => {
    const { format, rows } = parseStatement(WF_CSV)
    expect(format).toBe('csv-wf')
    expect(rows).toHaveLength(7)
    expect(rows[0]).toMatchObject({ postedOn: '2026-08-01', amountCents: -341800 })
    expect(rows[4]!.amountCents).toBe(1191800)
  })
  it('parses generic CSV with headers and mixed date formats', () => {
    const { format, rows } = parseStatement(GENERIC_CSV)
    expect(format).toBe('csv-generic')
    expect(rows.map((r) => r.amountCents)).toEqual([-21403, -18722, 625000])
    expect(rows[1]!.postedOn).toBe('2026-08-02')
  })
  it('parses OFX with FITIDs', () => {
    const { format, rows } = parseStatement(OFX)
    expect(format).toBe('ofx')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ postedOn: '2026-08-01', amountCents: -341800, fitid: '2026080101' })
    expect(rows[0]!.description).toContain('MORTGAGE PAYMENT')
  })
  it('rejects unrecognizable content', () => {
    expect(() => parseStatement('hello world')).toThrow(/Unrecognized/)
  })
})

describe('dedupeHashes', () => {
  it('gives identical same-day purchases distinct ordinals', () => {
    const { rows } = parseStatement(WF_CSV)
    const hashes = dedupeHashes(rows)
    expect(new Set(hashes).size).toBe(rows.length)
    const coffee = hashes.slice(5)
    expect(coffee[0]!.split('#')[0]).toBe(coffee[1]!.split('#')[0])
    expect(coffee[0]!.endsWith('#0')).toBe(true)
    expect(coffee[1]!.endsWith('#1')).toBe(true)
  })
  it('is stable across re-parses (re-import produces the same keys)', () => {
    expect(dedupeHashes(parseStatement(WF_CSV).rows)).toEqual(dedupeHashes(parseStatement(WF_CSV).rows))
  })
})

describe('importStatement', () => {
  function freshDb() {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('WF Checking', 'checking')").run()
    return db
  }

  it('imports, categorizes via seed rules, and skips nothing on first run', () => {
    const db = freshDb()
    const s = importStatement(db, { accountId: 1, filename: 'wf.csv', content: WF_CSV, importedBy: 't' })
    expect(s).toMatchObject({ format: 'csv-wf', rowsTotal: 7, imported: 7, skipped: 0 })
    const byCat = db
      .prepare(
        `SELECT COALESCE(c.name,'(none)') AS name, count(*) AS n FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id GROUP BY 1 ORDER BY 1`,
      )
      .all() as { name: string; n: number }[]
    const map = Object.fromEntries(byCat.map((r) => [r.name, r.n]))
    expect(map['Housing']).toBe(1) // MR. COOPER rule
    expect(map['Shopping']).toBe(1) // AMAZON rule
    expect(map['Transfer']).toBe(1) // ONLINE TRANSFER rule
    expect(map['Salary']).toBe(1) // PAYROLL rule
    expect(map['(none)']).toBe(3) // taqueria + two coffees — no rule yet
  })

  it('re-importing the same file skips every row; overlapping file skips only overlaps', () => {
    const db = freshDb()
    importStatement(db, { accountId: 1, filename: 'wf.csv', content: WF_CSV, importedBy: 't' })
    const again = importStatement(db, { accountId: 1, filename: 'wf.csv', content: WF_CSV, importedBy: 't' })
    expect(again).toMatchObject({ imported: 0, skipped: 7 })
    const overlap = WF_CSV + '\n"08/05/2026","-96.40","*","","TRADER JOES #202 SANTA BARBARA"'
    const s = importStatement(db, { accountId: 1, filename: 'wf2.csv', content: overlap, importedBy: 't' })
    expect(s).toMatchObject({ imported: 1, skipped: 7 })
    expect((db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n).toBe(8)
  })

  it('dedupes OFX by FITID', () => {
    const db = freshDb()
    importStatement(db, { accountId: 1, filename: 'a.ofx', content: OFX, importedBy: 't' })
    const s = importStatement(db, { accountId: 1, filename: 'b.ofx', content: OFX, importedBy: 't' })
    expect(s).toMatchObject({ imported: 0, skipped: 2 })
  })
})

describe('categorize', () => {
  const rules = [
    { id: 1, pattern: 'COFFEE', category_id: 12, priority: 0 },
    { id: 2, pattern: 'BLUE OWL COFFEE', category_id: 99, priority: 0 },
  ]
  it('prefers the longest matching pattern', () => {
    expect(categorize('BLUE OWL COFFEE GOLETA CA', rules)?.category_id).toBe(99)
    expect(categorize('PEETS COFFEE', rules)?.category_id).toBe(12)
    expect(categorize('SHELL OIL', rules)).toBeNull()
  })
})

describe('detectTransfers', () => {
  function dbWithTwoAccounts() {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Savings', 'savings')").run()
    return db
  }
  const insert = (db: ReturnType<typeof openDb>, acct: number, date: string, cents: number, desc: string) =>
    db
      .prepare(
        `INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(acct, date, cents, desc, `${acct}|${date}|${cents}|${desc}`)

  it('pairs equal-and-opposite amounts across accounts within the window', async () => {
    const { detectTransfers } = await import('./import')
    const db = dbWithTwoAccounts()
    insert(db, 1, '2026-08-03', -1200000, 'TRANSFER TO WAY2SAVE')
    insert(db, 2, '2026-08-04', 1200000, 'TRANSFER FROM CHECKING')
    insert(db, 1, '2026-08-05', -4500, 'COFFEE SHOP') // no partner
    expect(detectTransfers(db)).toBe(2)
    const kinds = db
      .prepare(
        `SELECT t.description, c.kind FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.id`,
      )
      .all() as { description: string; kind: string | null }[]
    expect(kinds[0]!.kind).toBe('transfer')
    expect(kinds[1]!.kind).toBe('transfer')
    expect(kinds[2]!.kind).toBeNull()
    // idempotent
    expect(detectTransfers(db)).toBe(0)
  })

  it('respects the day window, same-account exclusion, and manual categorization', async () => {
    const { detectTransfers } = await import('./import')
    const db = dbWithTwoAccounts()
    insert(db, 1, '2026-08-01', -50000, 'FAR APART OUT')
    insert(db, 2, '2026-08-09', 50000, 'FAR APART IN') // 8 days — no pair
    insert(db, 1, '2026-08-10', -7000, 'SAME ACCT OUT')
    insert(db, 1, '2026-08-10', 7000, 'SAME ACCT IN') // same account — no pair
    insert(db, 1, '2026-08-15', -9000, 'MANUAL OUT')
    db.prepare("UPDATE transactions SET categorized_by = 'manual', category_id = 12 WHERE description = 'MANUAL OUT'").run()
    insert(db, 2, '2026-08-15', 9000, 'MANUAL PARTNER IN')
    expect(detectTransfers(db)).toBe(0)
  })

  it('matches one-to-one: two identical debits, one credit → one pair', async () => {
    const { detectTransfers } = await import('./import')
    const db = dbWithTwoAccounts()
    insert(db, 1, '2026-08-03', -100000, 'TRANSFER A')
    insert(db, 1, '2026-08-04', -100000, 'TRANSFER B')
    insert(db, 2, '2026-08-03', 100000, 'RECEIVED')
    expect(detectTransfers(db)).toBe(2) // exactly one pair = 2 rows marked
    const unpaired = db
      .prepare('SELECT count(*) AS n FROM transactions WHERE category_id IS NULL')
      .get() as { n: number }
    expect(unpaired.n).toBe(1)
  })
})

describe('extractMerchant', () => {
  it('strips Wells Fargo purchase boilerplate down to the merchant', async () => {
    const { extractMerchant } = await import('./import')
    expect(
      extractMerchant("PURCHASE AUTHORIZED ON 08/02 TRADER JOE'S #202 SANTA BARBARA CA S466208538266502 CARD 2841"),
    ).toBe("TRADER JOE'S")
    expect(
      extractMerchant('RECURRING PAYMENT AUTHORIZED ON 07/28 NETFLIX.COM 866-579-7172 CA S123456789 CARD 2841'),
    ).toBe('NETFLIX.COM')
    expect(extractMerchant('PURCHASE AUTHORIZED ON 08/04 WHOLE FOODS MAR SANTA BARBARA CA P000000578 CARD 1234')).toBe(
      'WHOLE FOODS MAR SANTA',
    )
  })
  it('keeps plain descriptions, capped at four tokens', async () => {
    const { extractMerchant } = await import('./import')
    expect(extractMerchant('LA SUPER-RICA TAQUERIA SANTA BARBARA CA')).toBe('LA SUPER-RICA TAQUERIA SANTA')
    expect(extractMerchant('MR. COOPER MORTGAGE PYMT')).toBe('MR. COOPER MORTGAGE PYMT')
  })
})

describe('debit/credit column conventions', () => {
  it('handles Citi-style negative credits (payments) and positive debits (charges)', () => {
    const csv = `Status,Date,Description,Debit,Credit
Cleared,08/06/2026,AUTOPAY 123 AUTO-PMT,,-5601.00
Cleared,08/05/2026,COSTCO WHSE #0029,142.55,
Cleared,08/04/2026,REFUND FROM MERCHANT,,25.00`
    const { rows } = parseStatement(csv)
    expect(rows.map((r) => r.amountCents)).toEqual([560100, -14255, 2500])
  })
})
