import { parseMoneyField, parseQtyField } from '../ui/fieldParse'

/**
 * The first money box under `root` whose text doesn't parse, or null.
 *
 * A MoneyInput emits only text that parses, so while a box shows an error
 * its parent still holds the last good value — typing "12.345" leaves 12.34
 * behind. A form must not save that silently: check before submitting, and
 * focus the box (its inline error is already showing once it has committed).
 */
export function unparsedMoney(root: HTMLElement | null): HTMLInputElement | null {
  if (!root) return null
  return [...root.querySelectorAll<HTMLInputElement>('input.ui-num')].find((i) => parseMoneyField(i.value, { allowNegative: allowsNegative(i) }).error !== null) ?? null
}

/**
 * A MoneyInput that takes negative amounts (a margin cash balance) says so
 * the only way it shows in the page: a text keyboard instead of the decimal
 * pad, which has no minus key. Without this, "-150" in such a box read as
 * unparsed and blocked the save.
 */
const allowsNegative = (i: HTMLInputElement): boolean => i.inputMode === 'text'

/**
 * For a form that mixes money and share counts: the first box whose text
 * doesn't parse. Money boxes sit in a `.inv-moneybox` wrapper and share boxes
 * in `.inv-qtybox`, so each is read by its own parser ("10.123456" is fine
 * shares but not money).
 */
export function unparsedField(root: HTMLElement | null): HTMLInputElement | null {
  if (!root) return null
  const money = [...root.querySelectorAll<HTMLInputElement>('.inv-moneybox input.ui-num')].find((i) => parseMoneyField(i.value, { allowNegative: allowsNegative(i) }).error !== null)
  if (money) return money
  return [...root.querySelectorAll<HTMLInputElement>('.inv-qtybox input.ui-num')].find((i) => parseQtyField(i.value).error !== null) ?? null
}
