/**
 * A spending cap as typed in its box (Settings › Rented GPUs › Caps), in dollars: 0 when the box is empty (no cap), null
 * when the text does not read as one amount for sure. A cap is money: a text that could mean two amounts is refused
 * (the box goes back to the cap as saved) rather than read as the wrong one. "1,000" is a thousand, never $1.
 */
export function capAmount(text: string): number | null {
  // its sign before or after it, and spaces anywhere (a thousand typed "1 000"); a sign in the middle is not an amount
  const s = text.trim().replace(/^[$€]|[$€]$/g, "").replace(/\s/g, "");
  if (s === "") return 0;
  // a plain amount, its decimals after a point ("5", "12.5", ".5"); "1.000" alone could be a thousand written the
  // European way or one dollar: refused, unless its whole part is 0 ("0.125" is only ever an eighth)
  if (/^\d*\.?\d+$/.test(s) || /^\d+\.$/.test(s)) {
    if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) return null;
    return Number(s);
  }
  // a comma as the only separator, then one or two digits: the decimals written the European way ("2,5", "12,50")
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
  // thousands set apart by commas, decimals after a point ("1,000", "1,250.50")
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  // thousands set apart by points, decimals after a comma ("1.000,50")
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  return null;
}
