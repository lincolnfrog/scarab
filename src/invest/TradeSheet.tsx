import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { InvestAccountRow } from '../../engine/invest'
import type { PortfolioLot, PortfolioPosition, TradeBody, TradePreview } from '../../shared/invest-api'
import { formatCents, formatQtyMicro } from '../../shared/money'
import { post } from '../api'
import { localMode } from '../local'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { formatMoneyField } from '../ui/fieldParse'
import { DateInput, Field, FieldGrid, MoneyInput, QtyInput, Select } from '../ui/Field'
import { Segmented } from '../ui/Segmented'
import { toast } from '../ui/Toast'
import { useAction } from '../ui/useAction'
import { shortDay } from './balanceMath'
import { unparsedField } from './formGuard'
import { lotTerm, lotValueCents, perShareCents, sellableLots } from './lotMath'
import { useMarketSymbols } from './marketSymbols'
import { useRecordedAssets } from './recordedAssets'
import { SymbolInput } from './SymbolInput'
import { ambiguityText, lockedKindText, mergeRecorded, resolveSymbol, settleKind, symbolHint, type SymbolKind } from './symbolSearch'
import { formPriceCents, formTotalCents, tradeBody, type LotChoice, type TradeForm } from './tradeMath'
import './invest.css'

/** Where the sheet opens: an account, and optionally the lot a Sell… came from. */
export type TradeSheetInit = { accountId: number | null; lotTradeId: number | null }

export type TradeSheetProps = {
  open: boolean
  /** Lots-tracked accounts — the only ones trades are recorded in. */
  accounts: readonly InvestAccountRow[]
  positions: readonly PortfolioPosition[]
  init: TradeSheetInit
  today: string
  onClose: () => void
  /** After each trade is recorded (the screen reloads). */
  onRecorded: () => void
  /** "Already hold shares here?" — hands off to the starting-positions sheet. */
  onPasteOpening?: (accountId: number) => void
}

// The account the last trade went to, per data universe (household, or one tab session).
const lastAccount = new Map<string, number>()
const universe = () => (localMode.active ? `s${localMode.dataEpoch}` : 'h')

/**
 * Record a buy or sell: a drawer with the account (it remembers the last),
 * Buy/Sell, symbol, shares, the price per share or the total (the other is
 * worked out in integer cents), fees and the date. A sale picks FIFO, one of
 * the account's own open lots, or an explicit basis for shares Scarab never
 * tracked. As it's filled in, POST /api/trades/preview shows the gain, its
 * term, the estimated tax and any wash-sale trap — nothing is written until
 * Record. Enter records; ⌘/Ctrl-Enter records and starts another.
 */
export default function TradeSheet(p: TradeSheetProps) {
  if (!p.open || p.accounts.length === 0) return null
  return <Sheet {...p} />
}

function findLot(positions: readonly PortfolioPosition[], tradeId: number): { lot: PortfolioLot; position: PortfolioPosition } | null {
  for (const position of positions) {
    const lot = position.lots.find((l) => l.trade_id === tradeId)
    if (lot) return { lot, position }
  }
  return null
}

const defaultKind = (a: InvestAccountRow | undefined): 'stock' | 'crypto' => (a?.kind === 'crypto' ? 'crypto' : 'stock')

function initialForm(p: TradeSheetProps): TradeForm {
  const from = p.init.lotTradeId !== null ? findLot(p.positions, p.init.lotTradeId) : null
  const valid = (id: number | null | undefined) => (id != null && p.accounts.some((a) => a.id === id) ? id : null)
  const accountId = from?.lot.invest_account_id ?? valid(p.init.accountId) ?? valid(lastAccount.get(universe())) ?? p.accounts[0]!.id
  const account = p.accounts.find((a) => a.id === accountId)
  return {
    accountId,
    side: from ? 'sell' : 'buy',
    symbol: from?.position.symbol ?? '',
    assetKind: from?.position.kind ?? defaultKind(account),
    qtyMicro: from?.lot.qty_micro ?? null,
    mode: 'price',
    priceCents: null,
    totalCents: null,
    feesCents: null,
    tradedOn: p.today,
    lot: from?.lot.trade_id ?? 'fifo',
    acquiredOn: '',
    basisCents: null,
  }
}

export type PreviewState = { state: 'idle' } | { state: 'loading'; last: TradePreview | null } | { state: 'ok'; preview: TradePreview } | { state: 'error'; message: string }

function Sheet({ accounts, positions, today, onClose, onRecorded, onPasteOpening, ...p }: TradeSheetProps) {
  const [form, setForm] = useState<TradeForm>(() => initialForm({ accounts, positions, today, onClose, onRecorded, ...p }))
  const [tried, setTried] = useState(false)
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' })
  const formRef = useRef<HTMLFormElement>(null)
  const symbolRef = useRef<HTMLInputElement>(null)
  const qtyRef = useRef<HTMLInputElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const kindRef = useRef<HTMLSelectElement>(null)
  const formId = useId()
  // Opened from a lot's Sell…: everything but the price is known, so start there.
  const [fromLot] = useState(() => form.symbol !== '')
  const set = (patch: Partial<TradeForm>) => setForm((f) => ({ ...f, ...patch }))
  // The kind someone chose (in Kind, or by picking a suggestion) for a symbol Scarab hasn't recorded.
  const [picked, setPicked] = useState<SymbolKind | null>(null)
  const market = useMarketSymbols()
  const { assets, reload: reloadAssets } = useRecordedAssets()
  const recorded = useMemo(() => mergeRecorded(assets, positions), [assets, positions])

  const account = accounts.find((a) => a.id === form.accountId)
  const sym = form.symbol.trim().toUpperCase()
  const res = resolveSymbol(form.symbol, recorded, market?.index ?? null)
  // A recorded symbol keeps its kind (the engine refuses the other one) and its spelling (BRK-B typed is BRK.B held).
  const settled = settleKind(res, picked, defaultKind(account))
  const kind = settled.kind
  const listed = kind === 'crypto' ? res.crypto : res.stock
  // New to Scarab: the market list's spelling (BRK-B typed is booked as BRK.B).
  const canonical = res.recorded?.symbol ?? listed?.symbol ?? sym
  const known = positions.find((x) => x.symbol === canonical)
  const effective: TradeForm = { ...form, symbol: canonical, assetKind: kind }
  const lots = form.side === 'sell' ? sellableLots(positions, canonical, form.accountId) : []
  const lotGone = typeof form.lot === 'number' && !lots.some((l) => l.trade_id === form.lot)
  const heldHere = positions.filter((x) => x.accounts.some((a) => a.invest_account_id === form.accountId))
  const heldKey = heldHere.map((x) => x.symbol).join(' ')
  const heldSymbols = useMemo(() => new Set(heldKey ? heldKey.split(' ') : []), [heldKey])
  const built = tradeBody(effective, today)
  const body = 'body' in built && !lotGone && !settled.ambiguous ? built.body : null
  const complaint = settled.ambiguous ? ambiguityText(res) : 'error' in built ? built.error : null
  const bodyKey = body ? JSON.stringify(body) : ''
  const total = formTotalCents(form)
  const price = formPriceCents(form)

  // Preview as it's typed: debounced, and only the latest reply counts.
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    if (!bodyKey) {
      setPreview({ state: 'idle' })
      return
    }
    setPreview((s) => ({ state: 'loading', last: s.state === 'ok' ? s.preview : s.state === 'loading' ? s.last : null }))
    const t = setTimeout(() => {
      post<TradePreview>('/api/trades/preview', JSON.parse(bodyKey) as TradeBody)
        .then((r) => n === seq.current && setPreview({ state: 'ok', preview: r }))
        .catch((e: unknown) => n === seq.current && setPreview({ state: 'error', message: e instanceof Error ? e.message : String(e) }))
    }, 250)
    return () => clearTimeout(t)
  }, [bodyKey])

  const record = useAction(
    async (b: TradeBody, qtyMicro: number, another: boolean) => {
      const r = await post<{ id: number }>('/api/trades', b)
      return { ...r, body: b, qtyMicro, another }
    },
    {
      success: (r) => `Recorded: ${r.body.side} ${formatQtyMicro(r.qtyMicro)} ${r.body.symbol} for ${formatCents(r.body.totalCents)}`,
      errorPrefix: "Couldn't record the trade",
      onDone: (r) => {
        lastAccount.set(universe(), r.body.investAccountId)
        onRecorded()
        if (!r.another) return onClose()
        // Another on the same account, side and day: clear what differs per trade.
        setForm((f) => ({ ...f, symbol: '', qtyMicro: null, priceCents: null, totalCents: null, feesCents: null, lot: 'fifo', acquiredOn: '', basisCents: null }))
        setPicked(null)
        reloadAssets() // the trade may have recorded a new symbol: its kind is fixed now
        setTried(false)
        // The symbol box is already mounted; focus it once this update has rendered.
        setTimeout(() => symbolRef.current?.focus(), 0)
      },
    },
  )

  const submit = (another: boolean) => {
    if (record.busy) return
    setTried(true)
    const bad = unparsedField(formRef.current)
    if (bad) {
      bad.focus()
      return
    }
    if (!body) {
      // Put the cursor on the first thing still missing.
      const missing = !sym
        ? symbolRef.current
        : settled.ambiguous
          ? kindRef.current
          : form.qtyMicro === null
            ? qtyRef.current
            : total === null
              ? amountRef.current
              : null
      missing?.focus()
      if (complaint) toast.error(complaint)
      return
    }
    void record.run(body, form.qtyMicro!, another)
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    submit(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit(true)
    }
  }

  const missing = (v: unknown) => (tried && (v === null || v === '') ? 'Required' : null)
  const verb = form.side === 'buy' ? 'paid' : 'received'
  const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)

  return (
    <Drawer
      open
      width={600}
      onClose={onClose}
      dismissible={!record.busy}
      title="Record trade"
      subtitle={account ? `${account.name} · ${account.kind === 'retirement' ? 'tax-advantaged' : account.kind === 'crypto' ? 'crypto' : 'taxable'}` : undefined}
      footer={
        <>
          {onPasteOpening && (
            <span className="ui-foot-start">
              <button type="button" className="inv-linkbtn" onClick={() => onPasteOpening(form.accountId)}>
                Already hold shares? Paste starting positions
              </button>
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {/* One line: in a 600px sheet the link beside it wraps instead. */}
          <Button className="inv-nw" title={`${mac ? '⌘' : 'Ctrl'}+Enter`} busy={record.busy} onClick={() => submit(true)}>
            Record &amp; add another
          </Button>
          <Button type="submit" form={formId} variant="gold" busy={record.busy}>
            Record
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className="inv-form inv-trade" onSubmit={onSubmit} onKeyDown={onKeyDown} noValidate>
        <FieldGrid min={160}>
          <Field label="Account">
            <Select
              value={form.accountId}
              onChange={(e) => set({ accountId: Number(e.target.value), lot: 'fifo' })}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </Field>
          <div className="ui-field">
            <span className="ui-field-label" id={`${formId}-side`}>Side</span>
            <Segmented
              aria-label="Buy or sell"
              size="md"
              value={form.side}
              options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]}
              onChange={(side) => set({ side, lot: 'fifo' })}
            />
          </div>
          <Field label="Date" error={tried && !form.tradedOn ? 'Required' : null}>
            <DateInput value={form.tradedOn} max={today} onChange={(tradedOn) => set({ tradedOn })} />
          </Field>
        </FieldGrid>

        <FieldGrid min={160}>
          <Field label="Symbol" error={missing(sym)} hint={symbolHint(res, kind, settled.ambiguous, market !== null, formatCents)}>
            <SymbolInput
              ref={symbolRef}
              autoFocus={!fromLot}
              placeholder={form.side === 'sell' ? (heldHere[0]?.symbol ?? 'VTI') : 'VTI or a name'}
              recorded={recorded}
              market={market?.index ?? null}
              held={heldSymbols}
              preferKind={defaultKind(account)}
              value={form.symbol}
              onChange={(symbol) => {
                set({ symbol, lot: 'fifo' })
                setPicked(null)
              }}
              onPick={(o) => setPicked(o.kind)}
            />
          </Field>
          <Field
            label="Kind"
            hint={settled.locked && res.recorded ? lockedKindText(res.recorded) : undefined}
            error={settled.ambiguous ? 'Listed both ways — choose one' : null}
          >
            <Select ref={kindRef} value={settled.ambiguous ? '' : kind} disabled={settled.locked} onChange={(e) => setPicked(e.target.value as SymbolKind)}>
              {settled.ambiguous && (
                <option value="" disabled>
                  Choose…
                </option>
              )}
              <option value="stock">{settled.ambiguous && res.stock?.name ? `stock / ETF — ${res.stock.name}` : 'stock / ETF / fund'}</option>
              <option value="crypto">{settled.ambiguous && res.crypto?.name ? `crypto — ${res.crypto.name}` : 'crypto'}</option>
            </Select>
          </Field>
          <Field label="Shares" error={missing(form.qtyMicro)}>
            <span className="inv-qtybox">
              <QtyInput ref={qtyRef} valueMicro={form.qtyMicro} placeholder="10 or 0.05" onChange={(qtyMicro) => set({ qtyMicro })} />
            </span>
          </Field>
        </FieldGrid>

        <div className="inv-amounts">
          <div className="ui-field">
            <span className="ui-field-label">Enter</span>
            <Segmented
              aria-label="Enter the price per share or the total"
              value={form.mode}
              options={[{ value: 'price', label: 'Price / share' }, { value: 'total', label: `Total ${verb}` }]}
              onChange={(mode) =>
                // Carry the figure across so switching never loses what was typed.
                set(mode === 'total' ? { mode, totalCents: total ?? form.totalCents } : { mode, priceCents: price ?? form.priceCents })
              }
            />
          </div>
          {form.mode === 'price' ? (
            <Field label="Price per share" error={missing(form.priceCents)}>
              <span className="inv-moneybox">
                <MoneyInput
                  ref={amountRef}
                  autoFocus={fromLot}
                  value={form.priceCents}
                  placeholder={
                    known?.price_cents != null
                      ? formatMoneyField(known.price_cents)
                      : listed?.cents != null
                        ? formatMoneyField(listed.cents)
                        : undefined
                  }
                  onChange={(priceCents) => set({ priceCents })}
                />
              </span>
            </Field>
          ) : (
            <Field label={`Total ${verb}`} hint="Fees included" error={missing(form.totalCents)}>
              <span className="inv-moneybox">
                <MoneyInput ref={amountRef} value={form.totalCents} onChange={(totalCents) => set({ totalCents })} />
              </span>
            </Field>
          )}
          <Field label="Fees" hint="Optional">
            <span className="inv-moneybox">
              <MoneyInput value={form.feesCents} placeholder="0.00" onChange={(feesCents) => set({ feesCents })} />
            </span>
          </Field>
          <p className="inv-derived" aria-live="polite">
            {form.mode === 'price'
              ? total !== null
                ? total < 0
                  ? 'The fees are more than the sale brings in.'
                  : <>Total {verb}: <b>{formatCents(total)}</b>{form.feesCents ? ` (incl. ${formatCents(form.feesCents)} fees)` : ''}</>
                : ' '
              : price !== null
                ? <>≈ <b>{formatCents(price)}</b> per share{form.feesCents ? ' after fees' : ''}</>
                : ' '}
          </p>
        </div>

        {form.side === 'sell' && (
          <LotPicker
            lots={lots}
            value={form.lot}
            gone={lotGone}
            priceCents={price}
            qtyMicro={form.qtyMicro}
            today={today}
            symbol={canonical}
            accountName={account?.name ?? ''}
            onChange={(lot) => set({ lot })}
          />
        )}
        {form.side === 'sell' && form.lot === 'manual' && (
          <FieldGrid min={180}>
            <Field label="Acquired" hint="When those shares were bought or vested" error={missing(form.acquiredOn)}>
              <DateInput value={form.acquiredOn} max={form.tradedOn || today} onChange={(acquiredOn) => set({ acquiredOn })} />
            </Field>
            <Field label="Cost basis (total)" hint="What those shares cost, fees included" error={missing(form.basisCents)}>
              <span className="inv-moneybox">
                <MoneyInput value={form.basisCents} onChange={(basisCents) => set({ basisCents })} />
              </span>
            </Field>
          </FieldGrid>
        )}

        <PreviewPane state={preview} side={form.side} today={today} complaint={complaint} />
      </form>
    </Drawer>
  )
}

function LotPicker(p: {
  lots: PortfolioLot[]
  value: LotChoice
  gone: boolean
  priceCents: number | null
  qtyMicro: number | null
  today: string
  symbol: string
  accountName: string
  onChange: (v: LotChoice) => void
}) {
  const name = useId()
  const radio = (v: LotChoice, key: string) => (
    <input
      type="radio"
      name={name}
      id={`${name}-${key}`}
      checked={p.value === v}
      onChange={() => p.onChange(v)}
    />
  )
  return (
    <fieldset className="inv-lotpick">
      <legend className="ui-field-label">Shares sold from</legend>
      {p.gone && <p className="ui-field-err">That lot isn’t open in {p.accountName} — pick another.</p>}
      <table>
        <tbody>
          <tr className={p.value === 'fifo' ? 'inv-picked' : undefined}>
            <td className="inv-radio">{radio('fifo', 'fifo')}</td>
            <td colSpan={4}>
              <label htmlFor={`${name}-fifo`}>Oldest lots first (FIFO)</label>
              {p.lots.length === 0 && p.symbol && <span className="inv-note"> · no open {p.symbol} lots in {p.accountName}</span>}
            </td>
          </tr>
          {p.lots.map((l) => {
            const term = lotTerm(l, p.today)
            const tag = term.kind === 'sheltered' ? 'tax-deferred' : term.kind === 'lt' ? 'long-term' : `short-term · long-term in ${term.daysToLt}d` // the Holdings table's words
            const take = p.qtyMicro !== null ? Math.min(p.qtyMicro, l.qty_micro) : l.qty_micro
            const cost = Math.round((l.cost_cents * take) / l.qty_micro)
            const gain = p.priceCents !== null ? lotValueCents(take, p.priceCents) - cost : null
            const short = p.value === l.trade_id && p.qtyMicro !== null && p.qtyMicro > l.qty_micro
            return (
              <tr key={l.trade_id} className={p.value === l.trade_id ? 'inv-picked' : undefined}>
                <td className="inv-radio">{radio(l.trade_id!, String(l.trade_id))}</td>
                <td>
                  <span className="inv-lotcell">
                    <label htmlFor={`${name}-${l.trade_id}`}>lot · {l.opened_on}</label>
                    <span className="inv-tag">{tag}</span>
                    {short && <span className="inv-note">holds only {formatQtyMicro(l.qty_micro)} sh</span>}
                  </span>
                </td>
                <td className="r num muted">{formatQtyMicro(l.qty_micro)} sh</td>
                <td className="r num muted">{formatCents(perShareCents(l.cost_cents, l.qty_micro))}/sh</td>
                <td className={`r num ${gain === null || gain === 0 ? 'muted' : gain > 0 ? 'pos' : 'neg'}`} title={gain === null ? undefined : `Gain on ${formatQtyMicro(take)} sh at this price`}>
                  {gain === null ? '—' : formatCents(gain, { sign: gain !== 0 })}
                </td>
              </tr>
            )
          })}
          <tr className={p.value === 'manual' ? 'inv-picked' : undefined}>
            <td className="inv-radio">{radio('manual', 'manual')}</td>
            <td colSpan={4}>
              <label htmlFor={`${name}-manual`}>Shares Scarab doesn’t track — enter their basis</label>
            </td>
          </tr>
        </tbody>
      </table>
    </fieldset>
  )
}

const money = (c: number) => formatCents(c, { sign: c !== 0 })
/** Up and down are for gains and losses; $0 is neither. */
const tone = (c: number) => (c > 0 ? 'pos' : c < 0 ? 'neg' : undefined)

/**
 * What a flagged buy is, when it isn't a plain purchase. A starting position
 * counts from its acquisition date, or its as-of date when it has none —
 * giving it the real date (Activity → Edit) clears a false flag.
 */
const washBuyNote = (note: string | null) => (note === 'RSU vest' ? ', a vest' : note === 'Opening position' ? ', a starting position' : '')

/** The preview under the form: gain by lot and term, the tax estimate, wash-sale traps. Exported for the render test. */
export function PreviewPane({ state, side, today, complaint }: { state: PreviewState; side: 'buy' | 'sell'; today: string; complaint: string | null }) {
  if (complaint)
    return (
      <section className="inv-preview-pane" aria-live="polite">
        <p className="ui-formerr" role="alert">{complaint}</p>
      </section>
    )
  if (state.state === 'idle')
    return (
      <section className="inv-preview-pane inv-quietpane" aria-live="polite">
        <p className="inv-note">
          {side === 'sell'
            ? 'Fill in the symbol, shares and price to see the gain, its term, the estimated tax and any wash-sale trap before recording.'
            : 'Fill in the symbol, shares and price to check for wash sales before recording.'}
        </p>
      </section>
    )
  if (state.state === 'error')
    return (
      <section className="inv-preview-pane" aria-live="polite">
        <p className="ui-formerr" role="alert">{state.message}</p>
      </section>
    )
  const pv = state.state === 'ok' ? state.preview : state.last
  if (!pv) return <section className="inv-preview-pane inv-quietpane" aria-busy="true"><p className="inv-note">Working it out…</p></section>
  const gain = pv.realized.stCents + pv.realized.ltCents
  const w = pv.washSale
  return (
    // A buy's preview is only the wash-sale callout (and warnings): drop the pane's own box rather than nest one box in another.
    <section
      className={`inv-preview-pane${pv.side === 'buy' && w.risk ? ' inv-pane-bare' : ''}${state.state === 'loading' ? ' inv-stale-pane' : ''}`}
      aria-live="polite"
      aria-busy={state.state === 'loading'}
    >
      {pv.side === 'sell' && (
        <>
          <div className="inv-pv-row">
            <span>Realized gain</span>
            <b className={gain > 0 ? 'pos' : gain < 0 ? 'neg' : undefined}>{money(gain)}</b>
          </div>
          <div className="inv-pv-sub">
            {pv.realized.ltCents !== 0 && <span>long-term {money(pv.realized.ltCents)}</span>}
            {pv.realized.stCents !== 0 && <span>short-term {money(pv.realized.stCents)}</span>}
            {pv.zeroBasisCents > 0 && <span>{formatCents(pv.zeroBasisCents)} of it at zero basis</span>}
          </div>
          {pv.parts.length > 0 && (
            <ul className="inv-pv-parts">
              {pv.parts.map((x, i) => (
                <li key={`${x.lot_trade_id ?? 'x'}-${i}`}>
                  <span>
                    {x.lot_trade_id === null ? 'entered basis' : 'lot'} · {x.opened_on} · {formatQtyMicro(x.qty_micro)} sh ·{' '}
                    {x.term === 'lt' ? 'long-term' : 'short-term'}
                  </span>
                  <span className={tone(x.proceeds_cents - x.cost_cents)}>{money(x.proceeds_cents - x.cost_cents)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="inv-pv-row">
            <span>Estimated tax</span>
            {pv.sheltered ? (
              <span className="inv-note">none — {pv.account} is tax-advantaged</span>
            ) : pv.estTaxCents === null ? (
              <span className="inv-note">falls in the {pv.taxYear} tax year — not estimated here</span>
            ) : pv.estTaxCents === 0 ? (
              <span className="inv-note">no change to this year’s tax</span>
            ) : pv.estTaxCents < 0 ? (
              <b>saves ≈ {formatCents(-pv.estTaxCents)}</b>
            ) : (
              <b>≈ {formatCents(pv.estTaxCents)}</b>
            )}
          </div>
          {!pv.sheltered && pv.estTaxCents !== null && (
            <p className="inv-note">On your {pv.taxYear} return, netted with this year’s other gains and losses at your Taxes settings.</p>
          )}
        </>
      )}
      {w.risk && (
        <div className="inv-callout" role="note">
          <b>Wash-sale risk</b>
          {pv.side === 'sell' && w.buys.length > 0 && (
            <p>
              {w.buys.length === 1 ? 'A buy' : `${w.buys.length} buys`} of this stock within 30 days —{' '}
              {w.buys.map((b) => `${b.account} ${shortDay(b.acquired_on, today)} (${formatQtyMicro(b.qty_micro)} sh${washBuyNote(b.note)})`).join(', ')}.
              {' '}
              {w.buys.some((b) => b.sheltered)
                ? `The ${formatCents(-gain)} loss may be disallowed — and a buy inside a tax-advantaged account doesn’t take it into its basis, so that part is lost for good.`
                : `The ${formatCents(-gain)} loss may be disallowed and added to those shares’ basis instead.`}
            </p>
          )}
          {pv.side === 'sell' && w.upcomingVest && (
            <p>
              A vest of {formatQtyMicro(w.upcomingVest.qty_micro)} sh into {w.upcomingVest.account} is scheduled for{' '}
              {shortDay(w.upcomingVest.vest_on, today)} — within 30 days after this sale, so it would count as buying back.
            </p>
          )}
          {pv.side === 'buy' &&
            w.lossSales.map((s) => (
              <p key={s.trade_id}>
                Sold at a {formatCents(s.loss_cents)} loss in {s.account} on {shortDay(s.traded_on, today)} — buying within 30 days of that sale may disallow the loss.
              </p>
            ))}
        </div>
      )}
      {pv.warnings.map((x) => (
        <p key={x} className="inv-pv-warn">{x}</p>
      ))}
      {pv.side === 'buy' && !w.risk && pv.warnings.length === 0 && (
        <p className="inv-note">No wash-sale trap: no taxable sale of this stock at a loss within 30 days of this buy.</p>
      )}
    </section>
  )
}
