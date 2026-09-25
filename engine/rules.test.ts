import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { importStatement, parseRules } from './import'
import { ApiError, importRules, patchTransaction } from './services'
import { onBothEngines } from './test/parity'

const mem = () => openDb(':memory:') as unknown as DbLike
const changes = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

const CSV = `Date,Description,Amount
2026-08-01,NUGGET MARKET #18 GRANITE BAY CA,-52.10
2026-08-02,SQ *AMY-GYPSY ROSE SALON,-80.00
2026-08-03,SQ *ROUNDHOUSE DELI ROSEVILLE,-14.25
2026-08-04,LTF*LIFE TIME MO DUES,-250.00
2026-08-05,GREEN ACRES ROCKLIN ROCKLIN CA,-40.00`

function seeded() {
  const db = mem()
  db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
  importStatement(db, { accountId: 1, filename: 'a.csv', content: CSV, importedBy: 't' })
  return db
}
const filed = (db: DbLike) =>
  Object.fromEntries(
    (
      db
        .prepare(
          `SELECT t.description AS d, c.name AS c, t.categorized_by AS by FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.id`,
        )
        .all() as { d: string; c: string | null; by: string | null }[]
    ).map((r) => [r.d, r.c]),
  )

describe('parseRules', () => {
  it('reads tabs or arrows, skips comments, blanks and a header, and normalizes patterns', () => {
    const p = parseRules('pattern\tcategory\n# groceries\n\nnugget   market\tGroceries\nSQ *AMY -> Personal care\t1\nLIFE TIME → Fitness\n')
    expect(p.errors).toEqual([])
    expect(p.rules).toEqual([
      { line: 4, pattern: 'NUGGET MARKET', category: 'Groceries', priority: null },
      { line: 5, pattern: 'SQ *AMY', category: 'Personal care', priority: 1 },
      { line: 6, pattern: 'LIFE TIME', category: 'Fitness', priority: null },
    ])
  })

  it('keeps commas inside a pattern', () => {
    expect(parseRules('PAYMENT, THANK YOU\tTransfer').rules[0]!.pattern).toBe('PAYMENT, THANK YOU')
  })

  it('names the line of every bad row', () => {
    const p = parseRules('AB\tDining\nNUGGET\nWAYMO\tTransportation\tlots\nWAYMO\tTransportation\nwaymo\tTravel')
    expect(p.errors.map((e) => e.line)).toEqual([1, 2, 3, 5])
    expect(p.errors[3]!.message).toContain('line 4')
    expect(p.rules.map((r) => r.pattern)).toEqual(['WAYMO'])
  })
})

describe('importRules', () => {
  it('creates missing categories, adds rules and re-files past transactions', () => {
    const db = seeded()
    expect(filed(db)['SQ *AMY-GYPSY ROSE SALON']).toBe('Dining') // the seed "SQ *" rule
    const r = importRules(db, {
      text: 'NUGGET MARKET\tGroceries\nSQ *AMY-GYPSY\tPersonal care\nLIFE TIME\tFitness\nGREEN ACRES\tgardening',
    })
    expect(r).toEqual({ added: 4, updated: 0, unchanged: 0, categoriesCreated: ['Personal care', 'Fitness'], refiled: 4 })
    expect(filed(db)).toMatchObject({
      'NUGGET MARKET #18 GRANITE BAY CA': 'Groceries',
      'SQ *AMY-GYPSY ROSE SALON': 'Personal care', // the longer pattern beats the seed rule
      'SQ *ROUNDHOUSE DELI ROSEVILLE': 'Dining',
      'LTF*LIFE TIME MO DUES': 'Fitness',
      'GREEN ACRES ROCKLIN ROCKLIN CA': 'Gardening', // matched to the existing category, whatever the case
    })
    const kinds = db.prepare("SELECT kind FROM categories WHERE name IN ('Personal care', 'Fitness')").all()
    expect(kinds).toEqual([{ kind: 'expense' }, { kind: 'expense' }])
  })

  it('updates a pattern already on file and reports an identical one as unchanged', () => {
    const db = seeded()
    importRules(db, { text: 'LIFE TIME\tFitness' })
    const r = importRules(db, { text: 'LIFE TIME\tHealth\t3\nNUGGET MARKET\tGroceries' })
    expect(r).toMatchObject({ added: 1, updated: 1, unchanged: 0, categoriesCreated: [] })
    expect(db.prepare("SELECT priority FROM rules WHERE pattern = 'LIFE TIME'").get()).toEqual({ priority: 3 })
    expect(filed(db)['LTF*LIFE TIME MO DUES']).toBe('Health')
    expect(importRules(db, { text: 'LIFE TIME\tHealth' })).toMatchObject({ added: 0, updated: 0, unchanged: 1, refiled: 0 })
  })

  it('never re-files a transaction categorized by hand', () => {
    const db = seeded()
    const nugget = db.prepare("SELECT id FROM transactions WHERE description LIKE 'NUGGET%'").get() as { id: number }
    const shopping = db.prepare("SELECT id FROM categories WHERE name = 'Shopping'").get() as { id: number }
    patchTransaction(db, nugget.id, { categoryId: shopping.id })
    importRules(db, { text: 'NUGGET MARKET #18\tGroceries\t50' })
    expect(filed(db)['NUGGET MARKET #18 GRANITE BAY CA']).toBe('Shopping')
  })

  it('writes nothing when any line is bad', () => {
    const db = seeded()
    const before = changes(db)
    expect(() => importRules(db, { text: 'NUGGET MARKET\tGroceries\nX\tDining' })).toThrow(ApiError)
    expect(() => importRules(db, { text: '# nothing but a comment' })).toThrow(/no rules/)
    expect(() => importRules(db, {})).toThrow(/text required/)
    expect(changes(db)).toBe(before)
  })

  it('reads back identically on both engines', async () => {
    const { server, browser } = await onBothEngines(
      (db) => {
        db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
        importStatement(db, { accountId: 1, filename: 'a.csv', content: CSV, importedBy: 't' })
      },
      (db) => ({ result: importRules(db, { text: 'NUGGET MARKET\tGroceries\nLIFE TIME\tFitness' }), filed: filed(db) }),
    )
    expect(server.result.refiled).toBe(2)
    expect(browser).toEqual(server)
  })
})

describe('importRules and transfer pairs', () => {
  const PAIR_CSV_A = `Date,Description,Amount
2026-05-13,CASH BACK WITH PURCHASE,-100.00
2026-06-01,TRANSFER TO SAVINGS,-5000.00`
  const PAIR_CSV_B = `Date,Description,Amount
2026-05-12,TESLA REFUND,100.00
2026-06-02,TRANSFER FROM CHECKING,5000.00`
  function twoAccounts() {
    const db = mem()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking'), ('Card', 'checking')").run()
    importStatement(db, { accountId: 1, filename: 'a.csv', content: PAIR_CSV_A, importedBy: 't' })
    importStatement(db, { accountId: 2, filename: 'b.csv', content: PAIR_CSV_B, importedBy: 't' })
    return db
  }

  it('undoes a pair that rules imported later show to be a coincidence, and keeps the real one', () => {
    const db = twoAccounts()
    // Imported before any rule: $100 out and $100 in, a day apart, look like a transfer.
    expect(filed(db)['TESLA REFUND']).toBe('Transfer')
    const r = importRules(db, { text: 'CASH BACK WITH PURCHASE\tCash\nTESLA\tTransportation' })
    expect(filed(db)).toMatchObject({
      'CASH BACK WITH PURCHASE': 'Cash',
      'TESLA REFUND': 'Transportation',
      'TRANSFER TO SAVINGS': 'Transfer', // re-paired
      'TRANSFER FROM CHECKING': 'Transfer',
    })
    expect(r.refiled).toBe(2)
  })

  it('leaves the pairs alone, writing nothing, when no rule touches them', () => {
    const db = twoAccounts()
    importRules(db, { text: 'CASH BACK WITH PURCHASE\tCash\nTESLA\tTransportation' })
    const before = changes(db)
    expect(importRules(db, { text: 'CASH BACK WITH PURCHASE\tCash' })).toMatchObject({ unchanged: 1, refiled: 0 })
    expect(changes(db)).toBe(before)
  })
})
