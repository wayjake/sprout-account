const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/** Format without sign, for contexts where color/direction conveys it. */
export function formatCentsAbs(cents: number): string {
  return usd.format(Math.abs(cents) / 100);
}

/**
 * Parse a decimal money string ("1,234.56", "$-42.17", "(42.17)") to integer
 * cents without ever going through a float.
 */
export function parseCentsString(raw: string): number | null {
  let s = raw.trim();
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = !negative ? true : negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = /^(\d*)(?:\.(\d{0,4}))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) return null;
  const whole = m[1] === "" ? 0 : parseInt(m[1], 10);
  const fracRaw = (m[2] ?? "").padEnd(2, "0");
  // Round half-up on digits beyond cents (rare, e.g. "1.005")
  let centsPart = parseInt(fracRaw.slice(0, 2) || "0", 10);
  if (fracRaw.length > 2 && parseInt(fracRaw[2], 10) >= 5) centsPart += 1;
  let total = whole * 100 + centsPart;
  return negative ? -total : total;
}

/** Parse user form input like "12.34" or "-12.34" to cents. */
export function parseCentsInput(raw: string): number | null {
  return parseCentsString(raw);
}

/** Cents → "12.34" for form default values. */
export function centsToInput(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
