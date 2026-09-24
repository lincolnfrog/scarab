import type { getTax } from '../../engine/tax'

/**
 * GET /api/tax, typed from the engine function that answers it (server and
 * in-tab alike), so the harvest rows and totals the tax cards read can never
 * drift from what the engine sends.
 */
export type TaxResponse = ReturnType<typeof getTax>
