import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TimeChart, type TSeries } from './TimeChart'

const line = (id: string, vs: number[]): TSeries => ({
  id,
  label: id,
  points: vs.map((v, i) => ({ t: `2025-${String(i + 1).padStart(2, '0')}`, v })),
})
const html = (series: TSeries[], extra: Partial<Parameters<typeof TimeChart>[0]> = {}) =>
  renderToStaticMarkup(<TimeChart ariaLabel="test" series={series} {...extra} />)
const logButton = (h: string) => h.match(/<button[^>]*>Log<\/button>/)?.[0] ?? null

describe('TimeChart Lin/Log switch', () => {
  it('money values get the switch, with Log available while everything in view is above zero', () => {
    const h = html([line('nw', [100_00, 150_00, 400_00])])
    expect(h).toContain('aria-label="Scale"')
    expect(logButton(h)).not.toBeNull()
    expect(logButton(h)).not.toMatch(/disabled/)
  })

  it('offers Log but disabled when a value in view is zero or below', () => {
    const h = html([line('nw', [100_00, 150_00]), line('debt', [-50_00, -40_00])])
    expect(logButton(h)).toMatch(/disabled/)
  })

  it('has no switch on non-money units unless asked for', () => {
    expect(html([line('r', [1_000_000, 1_100_000])], { unit: 'index' })).not.toContain('aria-label="Scale"')
    expect(html([line('r', [1_000_000, 1_100_000])], { unit: 'index', scaleToggle: true })).toContain('aria-label="Scale"')
    expect(html([line('nw', [1, 2])], { scaleToggle: false })).not.toContain('aria-label="Scale"')
  })
})
