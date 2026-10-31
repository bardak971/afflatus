/**
 * A spending cap as typed in its box (Settings › Costs › Caps), in dollars: 0 when the box is empty (no cap), null
 * when the text does not read as one amount for sure. A cap is money: a text that could mean two amounts is refused
 * (the box goes back to the cap as saved) rather than read as the wrong one. "1,000" is a thousand, never $1.
 * Caps are in US dollars, as RunPod bills: "€50" is refused rather than taken as $50, which it is not. A typed 0 is
 * refused too: 0 is how "no cap" is kept, the opposite of what someone typing 0 to stop all spending means.
 */
export function capAmount(text: string): number | null {
  if (/[€£¥]/.test(text)) return null;
  // its sign before or after it, and spaces anywhere (a thousand typed "1 000"); a sign in the middle is not an amount
  const s = text.trim().replace(/^\$|\$$/g, "").replace(/\s/g, "");
  if (s === "") return 0;
  const n = amountOf(s);
  return n === 0 ? null : n;
}

/** The one amount a text without its sign or spaces reads as, or null. */
function amountOf(s: string): number | null {
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

/** Why capAmount refused a text, in the few words its box says under it. */
export function capRefusal(text: string): string {
  if (/[€£¥]/.test(text)) return "caps are in US dollars";
  if (/^[\s$]*[0.,]*0[0.,]*[\s$]*$/.test(text)) return "a cap is above $0 (empty: no cap)";
  return "not one amount for sure";
}
