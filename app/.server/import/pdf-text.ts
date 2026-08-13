import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { addDays } from "~/lib/dates";

/**
 * The statement's text layer, as a second witness.
 *
 * AI extraction of a statement fails in ways no prompt can fix: it miscounts
 * walls of near-identical lines (forty equal dispute credits, dozens of $0.05
 * reward-clawback sub-lines), and on statements that print every amount
 * unsigned in Deposits/Withdrawals columns it loses track of which column a
 * figure sat in — differently on every run. A digital statement, though,
 * carries a text layer that can be parsed deterministically — and the parse
 * can be *proved* right or discarded, because the printed opening and closing
 * balances say precisely what every line must sum to.
 *
 * That proof is the whole contract here: the audit returns rows only when
 * they tie out to the printed movement exactly, and null for anything else —
 * a scanned PDF with no text, a layout the parser does not recognise, a parse
 * that sums wrong. The caller swaps the audited rows in on success and keeps
 * the AI's result (and its hold) otherwise, so this pass can only ever turn a
 * held statement into a clean one, never the reverse.
 */

interface TextItem {
  x: number;
  width: number;
  str: string;
}

/** Every page's text as visual lines, each line its x-ordered items. */
async function pdfTextItemLines(buffer: Buffer): Promise<TextItem[][][]> {
  const task = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: TextItem[][][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // Group items into lines by their y position (PDF y grows upward, so
      // sort descending for reading order), then order by x within a line.
      // ±2 units of jitter absorbs items whose baselines don't quite agree.
      const byY = new Map<number, TextItem[]>();
      for (const item of content.items as {
        str?: string;
        width?: number;
        transform?: number[];
      }[]) {
        if (!item.str?.trim() || !item.transform) continue;
        const y = Math.round(item.transform[5]);
        let line = byY.get(y);
        if (!line) {
          for (const [yy, l] of byY) {
            if (Math.abs(yy - y) <= 2) {
              line = l;
              break;
            }
          }
        }
        if (!line) {
          line = [];
          byY.set(y, line);
        }
        line.push({ x: item.transform[4], width: item.width ?? 0, str: item.str });
      }
      pages.push(
        [...byY.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, items]) => items.sort((a, b) => a.x - b.x)),
      );
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

const joinLine = (items: TextItem[]) =>
  items
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

export interface AuditedRow {
  date: string;
  description: string;
  /** Decimal string in the same sign terms the caller's `expectedCents` used. */
  amount: string;
}

export interface AuditedStatement {
  transactions: AuditedRow[];
  /** Deterministically read from the closing date and billing-cycle length. */
  period: { start: string; end: string } | null;
  /** Printed terms, before the caller translates liability signs. */
  balances: { opening: string; closing: string } | null;
}

// Card statements use both leading and trailing minus signs. Robinhood, for
// example, prints a payment as `1,071.54-` rather than `-1,071.54`.
const MONEY = /-?\$?[\d,]+\.\d{2}-?/;
const MONEY_ALL = new RegExp(MONEY.source, "g");
const centsOf = (s: string) => {
  const text = s.trim();
  const negative = text.startsWith("-") || text.endsWith("-");
  const cents = Math.round(parseFloat(text.replace(/[-$,]/g, "")) * 100);
  return negative ? -cents : cents;
};
const asAmount = (cents: number) => (cents / 100).toFixed(2);

/**
 * Parse the statement's transaction lines out of its text layer and return
 * them only if they account for the printed balance movement exactly.
 *
 * Two layouts are understood, and exactness decides which — or neither — fits:
 *
 * - **Signed** (card statements): a transaction is a line starting with a date
 *   and ending with a signed amount; an undated "… Adjustment" sub-line
 *   beneath one is that row's reward clawback, at most one per parent, since a
 *   return earns exactly one. `expectedCents` and the returned amounts are in
 *   the statement's own printed terms — the caller owns the translation to
 *   household signs, exactly as it does for the AI's rows.
 *
 * - **Columnar** (bank statements): every amount prints unsigned and the sign
 *   is geometry — which header (Deposits/Additions, Withdrawals/Subtractions)
 *   the figure right-aligns under, with a running-balance column to ignore.
 *   Amounts are classified by nearest right edge. `expectedCents` is already
 *   household (deposits positive), so the rows come back that way.
 *
 * A wrong parse cannot sum to the right total by accident at cent precision,
 * which is what makes the narrowness of both models safe.
 */
export async function auditTransactionsFromText(
  buffer: Buffer,
  expectedCents: number | null,
  opts: { layout: "signed" | "columnar"; period?: { start: string | null; end: string | null } },
): Promise<AuditedStatement | null> {
  let pages: TextItem[][][];
  try {
    pages = await pdfTextItemLines(buffer);
  } catch {
    return null; // no text layer, or a PDF pdfjs cannot open — nothing to audit
  }
  const printedPeriod = statementPeriodFromText(pages);
  const printedBalances = statementBalancesFromText(pages);
  const expected = printedBalances
    ? centsOf(printedBalances.closing) - centsOf(printedBalances.opening)
    : expectedCents;
  if (expected == null) return null;
  const transactions =
    opts.layout === "signed"
      ? auditSigned(pages, expected, printedPeriod ?? opts.period)
      : auditColumnar(pages, expected, opts.period);
  if (!transactions) return null;
  return { transactions, period: printedPeriod, balances: printedBalances };
}

/**
 * The printed opening and closing balances alone, for a caller that only needs
 * the figures rather than a proved set of rows.
 *
 * The audit above is all-or-nothing by design — rows it cannot prove are worth
 * nothing — but the account-summary figures stand on their own: they are read
 * off two labelled lines, not reconstructed. That matters because AI extraction
 * drops a balance it has nowhere to date (American Express prints "Previous
 * Balance" undated, with no statement period on the page), and a statement that
 * arrives with only a closing figure is one nothing downstream can check: the
 * tie-out in `finalize` needs both ends, and without an opening anchor the
 * clamp has no boundary, so the first day's rows fall into the window belonging
 * to the statement before. Recovering the figure here costs a local parse and
 * no API call, and it is exact where the model was merely unlucky.
 *
 * Returns null for a scanned PDF, or one that labels its summary differently.
 */
export async function balancesFromText(
  buffer: Buffer,
): Promise<{ opening: string; closing: string } | null> {
  try {
    return statementBalancesFromText(await pdfTextItemLines(buffer));
  } catch {
    return null;
  }
}

/** The two account-summary figures that make a transaction audit provable. */
function statementBalancesFromText(
  pages: TextItem[][][],
): { opening: string; closing: string } | null {
  const lines = pages.flatMap((page) => page.map(joinLine));
  const money = `(${MONEY.source})`;
  const opening = lines
    .map((line) => line.match(new RegExp(`\\bprevious balance\\s+${money}`, "i")))
    .find(Boolean)?.[1];
  const closing = lines
    .map((line) => line.match(new RegExp(`(?:^|\\s)=?\\s*new balance\\s+${money}`, "i")))
    .find(Boolean)?.[1];
  if (!opening || !closing) return null;
  return { opening: asAmount(centsOf(opening)), closing: asAmount(centsOf(closing)) };
}

/**
 * Some issuers print only a closing date, not a `start - end` range. The cycle
 * length makes the missing start deterministic: a 31-day cycle closing Mar 20
 * begins Feb 18. This also supplies the year for year-less transaction tables.
 */
function statementPeriodFromText(
  pages: TextItem[][][],
): { start: string; end: string } | null {
  const lines = pages.flatMap((page) => page.map(joinLine));
  const closingLine = lines.find((line) => /statement closing date/i.test(line));
  const cycleLine = lines.find((line) => /days in billing cycle/i.test(line));
  const closing = closingLine?.match(
    /statement closing date\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i,
  );
  const cycle = cycleLine?.match(/days in billing cycle\s+(\d{1,3})\b/i);
  if (!closing || !cycle) return null;

  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const month = months.indexOf(closing[1].toLowerCase()) + 1;
  const days = Number(cycle[1]);
  if (month === 0 || !Number.isInteger(days) || days < 1 || days > 366) return null;

  const end = `${closing[3]}-${String(month).padStart(2, "0")}-${closing[2].padStart(2, "0")}`;
  const parsed = new Date(`${end}T00:00:00Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.getUTCFullYear() !== Number(closing[3]) ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== Number(closing[2])
  ) {
    return null;
  }
  return { start: addDays(end, -(days - 1)), end };
}

function auditSigned(
  pages: TextItem[][][],
  expectedCents: number,
  period?: { start: string | null; end: string | null } | null,
): AuditedRow[] | null {
  type Row = { date: string; description: string; cents: number; adjustment?: boolean };
  const rows: Row[] = [];
  let lastDated: Row | null = null;
  let inTransactions = false;

  // A year-less posting date belongs to the most recent occurrence on or
  // before the statement close. This handles a Dec -> Jan cycle without
  // guessing from the current calendar year.
  const datedFromPeriod = (month: string, day: string): string | null => {
    const boundary = period?.end ?? period?.start;
    if (!boundary) return null;
    let year = Number(boundary.slice(0, 4));
    const suffix = `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    let date = `${year}-${suffix}`;
    if (date > boundary) date = `${--year}-${suffix}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (
      Number.isNaN(parsed.valueOf()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() + 1 !== Number(month) ||
      parsed.getUTCDate() !== Number(day)
    ) {
      return null;
    }
    return date;
  };

  for (const page of pages) {
    for (const items of page) {
      const line = joinLine(items);
      if (/^transactions(?:\s+\(continued\))?\s*$/i.test(line)) {
        inTransactions = true;
        lastDated = null;
        continue;
      }
      if (/^total fees for this period\b|^interest charged\b/i.test(line)) {
        inTransactions = false;
        lastDated = null;
        continue;
      }

      const fullDate = line.match(/^(\d{2})\/(\d{2})\/(\d{2}(?:\d{2})?)\s+(.*)$/);
      const twoDates = inTransactions
        ? line.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2})\/(\d{1,2})\s+(.*)$/)
        : null;
      if (fullDate || twoDates) {
        const date = fullDate
          ? `${fullDate[3].length === 4 ? fullDate[3] : `20${fullDate[3]}`}-${fullDate[1]}-${fullDate[2]}`
          : datedFromPeriod(twoDates![3], twoDates![4]);
        let rest = fullDate?.[4] ?? twoDates![5];
        // Robinhood places a long reference number between the two dates and
        // the description. It identifies the row but is not merchant text.
        if (twoDates) rest = rest.replace(/^[A-Z0-9]{12,}\s+/, "");
        const amounts = rest.match(MONEY_ALL);
        if (!date || !amounts) {
          lastDated = null;
          continue;
        }
        const row: Row = {
          date,
          description: rest.replace(MONEY_ALL, "").replace(/\s+/g, " ").trim(),
          cents: centsOf(amounts[amounts.length - 1]),
        };
        rows.push(row);
        lastDated = row;
        continue;
      }
      if (/adjustment/i.test(line) && !/^total/i.test(line) && lastDated) {
        const amounts = line.match(MONEY_ALL);
        if (amounts) {
          rows.push({
            date: lastDated.date,
            description: line.replace(MONEY_ALL, "").replace(/\s+/g, " ").trim(),
            cents: centsOf(amounts[amounts.length - 1]),
            adjustment: true,
          });
          lastDated = null;
        }
      }
    }
  }

  // Two readings of the page, tried fullest-first: with the adjustment
  // sub-lines (they are genuine balance-affecting charges when present), and
  // without (a statement whose "adjustment" lines turn out to be informational
  // would only tie out this way).
  const datedOnly = rows.filter((r) => !r.adjustment);
  for (const candidate of [rows, datedOnly]) {
    const net = candidate.reduce((n, r) => n + r.cents, 0);
    if (candidate.length > 0 && net === expectedCents) {
      return candidate.map((r) => ({
        date: r.date,
        description: r.description,
        amount: asAmount(r.cents),
      }));
    }
  }
  return null;
}

function auditColumnar(
  pages: TextItem[][][],
  expectedCents: number,
  period?: { start: string | null; end: string | null },
): AuditedRow[] | null {
  // The most recent header row naming the money columns governs the rows below
  // it; a repeated header on a later page just re-establishes the same edges.
  // Right edges are what align in a column of right-justified figures.
  let columns: { deposit: number; withdrawal: number; balance: number | null } | null = null;

  const startYear = Number(period?.start?.slice(0, 4)) || null;
  const endYear = Number(period?.end?.slice(0, 4)) || null;
  const startMonth = Number(period?.start?.slice(5, 7)) || null;
  const yearFor = (month: number): number | null => {
    if (startYear && endYear && startYear !== endYear) {
      return startMonth && month >= startMonth ? startYear : endYear;
    }
    return startYear ?? endYear;
  };

  const rows: AuditedRow[] = [];
  for (const page of pages) {
    for (const items of page) {
      const right = (i: TextItem) => i.x + i.width;
      const deposit = items.find((i) => /^deposits\b|^deposits\//i.test(i.str.trim()));
      const withdrawal = items.find((i) => /^withdrawals\b|^withdrawals\//i.test(i.str.trim()));
      if (deposit && withdrawal) {
        const balance = items.find((i) => /balance/i.test(i.str) || /^ending/i.test(i.str.trim()));
        columns = {
          deposit: right(deposit),
          withdrawal: right(withdrawal),
          balance: balance ? right(balance) : null,
        };
        continue;
      }
      if (!columns) continue;

      const line = joinLine(items);
      const dated = line.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}(?:\d{2})?))?\s/);
      if (!dated) continue;
      const [, mStr, dStr, yStr] = dated;
      const month = Number(mStr);
      const year = yStr ? (yStr.length === 4 ? Number(yStr) : 2000 + Number(yStr)) : yearFor(month);
      if (!year) continue;
      const date = `${year}-${String(month).padStart(2, "0")}-${dStr.padStart(2, "0")}`;

      let cents = 0;
      let sawAmount = false;
      const descParts: string[] = [];
      for (const item of items) {
        const token = item.str.trim();
        if (new RegExp(`^${MONEY.source}$`).test(token)) {
          // Which column is this figure in? The nearest right edge decides;
          // the running-balance column is recognised and skipped.
          const edges: [number, number | null][] = [
            [1, columns.deposit],
            [-1, columns.withdrawal],
            [0, columns.balance],
          ];
          let best: { sign: number; dist: number } | null = null;
          for (const [sign, edge] of edges) {
            if (edge == null) continue;
            const dist = Math.abs(right(item) - edge);
            if (!best || dist < best.dist) best = { sign, dist };
          }
          if (best && best.sign !== 0) {
            cents += best.sign * centsOf(token);
            sawAmount = true;
          }
          continue;
        }
        descParts.push(token);
      }
      if (!sawAmount) continue;
      rows.push({
        date,
        // The date itself leads the joined parts; drop it from the description.
        description: descParts.join(" ").replace(/^\S+\s*/, "").replace(/\s+/g, " ").trim(),
        amount: asAmount(cents),
      });
    }
  }

  const net = rows.reduce((n, r) => n + centsOf(r.amount), 0);
  return rows.length > 0 && net === expectedCents ? rows : null;
}
