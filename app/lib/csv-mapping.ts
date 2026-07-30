import { z } from "zod";
import { parseCentsString } from "~/lib/money";

/** Isomorphic CSV mapping logic — used server-side for full parses and
 *  client-side for the live preview on the mapping form. */

export const DATE_FORMATS = [
  "YYYY-MM-DD",
  "MM/DD/YYYY",
  "M/D/YYYY",
  "DD/MM/YYYY",
  "YYYY/MM/DD",
  "MMM D, YYYY",
] as const;

export const AMOUNT_STYLES = [
  "single_signed",
  "single_inverted",
  "debit_credit",
] as const;

export const MappingSchema = z.object({
  dateColumn: z.string(),
  dateFormat: z.enum(DATE_FORMATS),
  /** Concatenated with " " for the transaction description. Empty for balance imports. */
  descriptionColumns: z.array(z.string()),
  /**
   * single_signed: one column, spend already negative.
   * single_inverted: one column, spend positive (typical credit-card exports) — inverted on import.
   * debit_credit: separate debit (spend) and credit (inflow) columns.
   */
  amountStyle: z.enum(AMOUNT_STYLES).nullable(),
  amountColumn: z.string().nullable(),
  debitColumn: z.string().nullable(),
  creditColumn: z.string().nullable(),
  /** For balance-kind accounts: the running/statement balance column. */
  balanceColumn: z.string().nullable(),
});

export type Mapping = z.infer<typeof MappingSchema>;

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

export function parseDateWithFormat(
  raw: string,
  format: (typeof DATE_FORMATS)[number],
): string | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number | undefined, m: number | undefined, d: number | undefined;

  if (format === "YYYY-MM-DD" || format === "YYYY/MM/DD") {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
    if (!match) return null;
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if (format === "MM/DD/YYYY" || format === "M/D/YYYY") {
    const match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(s);
    if (!match) return null;
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if (format === "DD/MM/YYYY") {
    const match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(s);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if (format === "MMM D, YYYY") {
    const match = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
    if (!match) return null;
    const mi = MONTHS.indexOf(match[1].slice(0, 3).toUpperCase());
    if (mi === -1) return null;
    [y, m, d] = [Number(match[3]), mi + 1, Number(match[2])];
  }

  if (y == null || m == null || d == null) return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso)
    return null;
  return iso;
}

export interface NormalizedTxnRow {
  date: string;
  description: string;
  amountCents: number;
}

export interface NormalizedBalanceRow {
  date: string;
  balanceCents: number;
}

export interface RowError {
  rowIndex: number;
  problem: string;
}

/**
 * A transactions file that also carries a running-balance column gives us a
 * balance anchor per day for free. Which row holds the day's closing balance
 * depends on the file's direction, so take the chronologically last row of
 * each date.
 */
function runningBalanceAnchors(
  rows: { rowIndex: number; date: string; balanceCents: number }[],
): (NormalizedBalanceRow & { rowIndex: number })[] {
  if (rows.length === 0) return [];
  const ascending = rows[0].date <= rows[rows.length - 1].date;
  const byDate = new Map<string, { rowIndex: number; date: string; balanceCents: number }>();
  for (const r of rows) {
    const seen = byDate.get(r.date);
    // ascending file: later row wins; descending file: earlier row wins
    if (!seen || (ascending ? r.rowIndex > seen.rowIndex : r.rowIndex < seen.rowIndex)) {
      byDate.set(r.date, r);
    }
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ rowIndex: r.rowIndex, date: r.date, balanceCents: r.balanceCents }));
}

/** Apply a mapping to parsed CSV records (objects keyed by header). */
export function applyMapping(
  records: Record<string, string>[],
  mapping: Mapping,
  kind: "transactions" | "balances",
): {
  txns: (NormalizedTxnRow & { rowIndex: number })[];
  balances: (NormalizedBalanceRow & { rowIndex: number })[];
  errors: RowError[];
} {
  const txns: (NormalizedTxnRow & { rowIndex: number })[] = [];
  const balances: (NormalizedBalanceRow & { rowIndex: number })[] = [];
  const running: { rowIndex: number; date: string; balanceCents: number }[] = [];
  const errors: RowError[] = [];

  records.forEach((rec, rowIndex) => {
    const rawDate = rec[mapping.dateColumn] ?? "";
    const date = parseDateWithFormat(rawDate, mapping.dateFormat);
    if (!date) {
      if (Object.values(rec).some((v) => v?.trim()))
        errors.push({ rowIndex, problem: `Unparseable date "${rawDate}"` });
      return;
    }

    if (kind === "balances") {
      const raw = rec[mapping.balanceColumn ?? ""] ?? "";
      const balanceCents = parseCentsString(raw);
      if (balanceCents == null) {
        errors.push({ rowIndex, problem: `Unparseable balance "${raw}"` });
        return;
      }
      balances.push({ rowIndex, date, balanceCents });
      return;
    }

    const description = mapping.descriptionColumns
      .map((c) => rec[c] ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    let amountCents: number | null = null;
    if (mapping.amountStyle === "debit_credit") {
      const debit = parseCentsString(rec[mapping.debitColumn ?? ""] ?? "");
      const credit = parseCentsString(rec[mapping.creditColumn ?? ""] ?? "");
      if (debit != null && debit !== 0) amountCents = -Math.abs(debit);
      else if (credit != null && credit !== 0) amountCents = Math.abs(credit);
      else if (debit === 0 || credit === 0) amountCents = 0;
    } else {
      const raw = rec[mapping.amountColumn ?? ""] ?? "";
      const parsed = parseCentsString(raw);
      if (parsed != null)
        amountCents = mapping.amountStyle === "single_inverted" ? -parsed : parsed;
    }

    if (amountCents == null) {
      errors.push({ rowIndex, problem: "Unparseable amount" });
      return;
    }
    if (!description && amountCents === 0) return;
    txns.push({ rowIndex, date, description: description || "(no description)", amountCents });

    // Optional running-balance column alongside the transactions
    if (mapping.balanceColumn) {
      const balanceCents = parseCentsString(rec[mapping.balanceColumn] ?? "");
      if (balanceCents != null) running.push({ rowIndex, date, balanceCents });
    }
  });

  return {
    txns,
    balances: kind === "balances" ? balances : runningBalanceAnchors(running),
    errors,
  };
}

/** Best-effort mapping guess from header names — fallback when AI is unavailable. */
export function heuristicMapping(
  headers: string[],
  sampleRows: Record<string, string>[],
  kind: "transactions" | "balances",
): Mapping {
  const lower = headers.map((h) => h.toLowerCase());
  const find = (...needles: string[]) => {
    for (const n of needles) {
      const i = lower.findIndex((h) => h.includes(n));
      if (i !== -1) return headers[i];
    }
    return null;
  };

  const dateColumn = find("post date", "posted", "transaction date", "date") ?? headers[0];
  const sample = sampleRows.map((r) => r[dateColumn] ?? "").find((v) => v.trim()) ?? "";
  let dateFormat: Mapping["dateFormat"] = "MM/DD/YYYY";
  if (/^\d{4}-/.test(sample)) dateFormat = "YYYY-MM-DD";
  else if (/^\d{4}\//.test(sample)) dateFormat = "YYYY/MM/DD";
  else if (/^[A-Za-z]/.test(sample)) dateFormat = "MMM D, YYYY";

  const debitColumn = find("debit", "withdrawal");
  const creditColumn = find("credit", "deposit");
  const amountColumn = find("amount");
  const descriptionColumn = find("description", "payee", "merchant", "memo", "name");
  const balanceColumn = find("balance", "value");

  return {
    dateColumn,
    dateFormat,
    descriptionColumns: descriptionColumn ? [descriptionColumn] : [],
    amountStyle:
      kind === "balances"
        ? null
        : debitColumn && creditColumn && !amountColumn
          ? "debit_credit"
          : "single_signed",
    amountColumn,
    debitColumn,
    creditColumn,
    balanceColumn,
  };
}
