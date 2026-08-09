import { z } from "zod";
import { chatJSON, pdfModel } from "~/.server/openrouter";
import { mapWithConcurrency, splitPdfPages, type PdfChunk } from "~/.server/import/pdf-split";
import { ACCOUNT_TYPE_LABELS, isLiability } from "~/lib/accounts";
import { formatCents, parseCentsString } from "~/lib/money";
import { addDays } from "~/lib/dates";
import type { AccountKind, AccountType } from "~/db/schema";

/** Chunk requests in flight at once — see `mapWithConcurrency`. */
const CHUNK_CONCURRENCY = 3;

const ExtractionSchema = z.object({
  statementStart: z.string().nullable(),
  statementEnd: z.string().nullable(),
  /** Last four digits of the account this statement belongs to, if printed */
  accountLastFour: z.string().nullable(),
  transactions: z.array(
    z.object({
      date: z.string(),
      description: z.string(),
      /** Decimal string like "-42.17" — parsed to cents server-side, never floats */
      amount: z.string(),
    }),
  ),
  balances: z.array(
    z.object({
      date: z.string(),
      balance: z.string(),
      /** "opening" or "closing" — which end of the period this balance is */
      kind: z.string(),
    }),
  ),
});

export interface PdfExtractionResult {
  transactions: {
    date: string;
    description: string;
    amountCents: number;
    /** The date the statement printed, when it differs from `date` — see the clamp below */
    matchDate?: string;
  }[];
  balances: { date: string; balanceCents: number; kind: string }[];
  statementStart: string | null;
  statementEnd: string | null;
  accountLastFour: string | null;
  problems: string[];
}

/**
 * A bank or card statement carries both the transactions and the balances that
 * bracket them, so we always ask for both — the closing balance is what makes
 * the imported rows checkable. Investment statements have no transactions to
 * speak of and yield balances only.
 */
export async function extractFromPdf(
  buffer: Buffer,
  filename: string,
  account: { kind: AccountKind; accountType: AccountType },
): Promise<PdfExtractionResult> {
  const chunks = await splitPdfPages(buffer);
  const raws = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, (chunk) =>
    extractChunk(chunk, chunks.length, filename, account),
  );
  // Deliberately one pass. A merged statement that fails the tie-out check
  // below is not a dice roll worth repeating: every failure observed was
  // structural — signs flipped on a statement thick with returns — and a second
  // pass reproduced it while doubling the work for exactly the longest
  // statements, the ones most likely to fail. The discrepancy is reported on
  // the close screen instead, where it can be looked at.
  return finalize(mergeRaw(raws), account);
}

type RawExtraction = z.infer<typeof ExtractionSchema>;

/**
 * Fold the chunks back into the shape a single request would have produced, so
 * everything downstream is unaware the statement was ever split. Transactions
 * concatenate in page order, which is document order. The period, the account
 * number and the balances are printed once, on the first page that carries
 * them, so the first chunk to report each wins — a later chunk repeating a
 * figure out of a running total cannot displace the printed one.
 */
function mergeRaw(raws: RawExtraction[]): RawExtraction {
  const balances: RawExtraction["balances"] = [];
  for (const kind of ["opening", "closing"]) {
    const hit = raws
      .flatMap((r) => r.balances)
      .find((b) => (b.kind?.toLowerCase() === "opening" ? "opening" : "closing") === kind);
    if (hit) balances.push(hit);
  }
  return {
    statementStart: raws.find((r) => r.statementStart)?.statementStart ?? null,
    statementEnd: raws.find((r) => r.statementEnd)?.statementEnd ?? null,
    accountLastFour: raws.find((r) => r.accountLastFour)?.accountLastFour ?? null,
    transactions: raws.flatMap((r) => r.transactions),
    balances,
  };
}

async function extractChunk(
  chunk: PdfChunk,
  chunkCount: number,
  filename: string,
  account: { kind: AccountKind; accountType: AccountType },
): Promise<RawExtraction> {
  const balanceOnly = account.kind === "balance";
  const owed = isLiability(account.accountType);
  const kindNoun = ACCOUNT_TYPE_LABELS[account.accountType].toLowerCase();
  const split = chunkCount > 1;

  return chatJSON({
    model: pdfModel(),
    system: `You extract data from financial statements with perfect accuracy.

${
  balanceOnly
    ? owed
      ? `This is a ${kindNoun} statement, tracked by balance only. Extract the amount OWED at each end of the statement period into the balances array — the opening balance (kind "opening") and the closing balance (kind "closing"). Use the PRINCIPAL balance outstanding, not the payment due, the escrow balance, or the original loan amount.
   - IMPORTANT: money owed is NEGATIVE. A principal balance of $312,450.22 must be reported as "-312450.22".
   - Leave the transactions array empty.`
      : `This is an investment or retirement statement. Extract the account VALUE at each end of the statement period into the balances array — the opening value (kind "opening") and the closing value (kind "closing"). Leave the transactions array empty.`
    : `This is a ${owed ? kindNoun : "bank"} statement. Extract TWO things:

1. EVERY transaction, into the transactions array.
   - Amounts are decimal strings. Sign convention: money leaving the account (purchases, fees, withdrawals, payments made) is NEGATIVE; money arriving (deposits, refunds, interest earned) is POSITIVE.${
     owed
       ? ` For this ${kindNoun}: charges, draws, interest and fees NEGATIVE (they add to what is owed); payments and credits POSITIVE (they reduce it).`
       : ""
   }
   - Skip running-balance columns, summary lines, subtotals and totals — individual transactions only.
   - A rewards figure printed on an ordinary purchase row — a rate and an amount such as "1%  $0.10" sitting in a Daily Cash or Rewards column beside the transaction amount — is cash back earned on that purchase. It belongs to that row and is NEVER a row of its own.
   - Indented sub-lines beneath a transaction are usually rewards *earned* (cash back, points, "3% Daily Cash at X", bonus offers). Those are not transactions — skip them. The exception is a reward *reversal* on a return or credit: a line whose own text names it an adjustment or reversal, such as a "Daily Cash Adjustment" shown at a negative rate under a return. That money is taken back from the account, so include it as its own row, dated like the line it sits under. Only a line that literally reads as an adjustment qualifies — never promote an earned-rewards figure into one. It is a charge, never a credit${
     owed
       ? `, so it must be NEGATIVE — a "Daily Cash Adjustment" of $0.26 printed under a $26.46 return is reported as "-0.26", even though the return above it is positive`
       : ""
   }.

2. The statement's opening and closing balances, into the balances array.
   - One entry with kind "opening" dated the first day of the statement period, one with kind "closing" dated the last day.
   - These are the "beginning balance" / "previous balance" and "ending balance" / "new balance" figures printed on the statement.${
     owed
       ? `
   - IMPORTANT: this is a ${kindNoun}, so a balance owed is NEGATIVE. A "new balance" of $1,234.56 owed must be reported as "-1234.56". Report a credit (overpayment) as positive.`
       : ""
   }
   - If only one of the two is printed, return just that one. If neither is printed, return an empty balances array — never invent or compute one.`
}
- Dates must be YYYY-MM-DD. Infer the year from the statement period when a line omits it.
- statementStart/statementEnd: the statement period dates if shown, else null.
- accountLastFour: the last four digits of the account number if printed, else null.${
      split
        ? `

You are being shown PAGES ${chunk.firstPage}–${chunk.lastPage} of a longer statement, not the whole document.
- Extract each row printed on these pages exactly once. The pages you cannot see are covered by their own extract, so never reach for a row that is not here, and never invent or repeat one — a row that does not appear on these pages is not missing, it is simply somebody else's.
- Balances, the statement period and the account number are printed once, usually on page 1. If these pages do not show them, return an empty balances array and null for the period and the account number. Do not infer a balance from a running total and never compute one.
- Page footers, repeated column headers, section totals and a rewards summary are not transactions.`
        : ""
    }`,
    user: [
      {
        type: "text",
        text: split
          ? `Extract from pages ${chunk.firstPage}–${chunk.lastPage} of this statement (${filename}).`
          : `Extract from this statement (${filename}).`,
      },
      {
        type: "file",
        file: {
          filename,
          file_data: `data:application/pdf;base64,${chunk.buffer.toString("base64")}`,
        },
      },
    ],
    schema: ExtractionSchema,
    schemaName: "statement_extraction",
  });
}

/**
 * Turn a merged raw extraction into the result the import pipeline consumes:
 * parse money and dates, place the anchors, pull stray rows into the period,
 * and check the whole thing against the balances the statement printed.
 */
function finalize(
  raw: RawExtraction,
  account: { kind: AccountKind; accountType: AccountType },
): PdfExtractionResult {
  const balanceOnly = account.kind === "balance";
  const owed = isLiability(account.accountType);
  const kindNoun = ACCOUNT_TYPE_LABELS[account.accountType].toLowerCase();

  const problems: string[] = [];
  const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  const transactions: PdfExtractionResult["transactions"] = [];
  for (const t of raw.transactions) {
    const amountCents = parseCentsString(t.amount);
    if (amountCents == null || !isoDate(t.date)) {
      problems.push(`Skipped row: ${t.date} ${t.description} ${t.amount}`);
      continue;
    }
    transactions.push({ date: t.date, description: t.description, amountCents });
  }

  const statementStart =
    raw.statementStart && isoDate(raw.statementStart) ? raw.statementStart : null;
  const statementEnd = raw.statementEnd && isoDate(raw.statementEnd) ? raw.statementEnd : null;

  // Not every statement prints its period, so fall back to the first day it
  // actually shows a transaction on — either way this is the day the opening
  // balance is "as of", and the only date we should move.
  const periodStart =
    statementStart ?? transactions.map((t) => t.date).sort()[0] ?? null;

  const balances: PdfExtractionResult["balances"] = [];
  for (const b of raw.balances) {
    const balanceCents = parseCentsString(b.balance);
    if (balanceCents == null || !isoDate(b.date)) {
      problems.push(`Skipped balance: ${b.date} ${b.balance}`);
      continue;
    }
    const kind = b.kind?.toLowerCase() === "opening" ? "opening" : "closing";
    // Anchors are end-of-day figures everywhere downstream: a window spans
    // (previous anchor, this anchor] and activity counts from the day *after*
    // an anchor. A statement's opening balance is the opposite — it is the
    // figure *before* the first day's transactions post. Left on the period's
    // first day it silently swallows that day's rows, so move it back a day,
    // where it also lines up exactly with the prior statement's closing anchor.
    const date =
      kind === "opening" && periodStart && b.date === periodStart ? addDays(b.date, -1) : b.date;
    balances.push({ date, balanceCents, kind });
  }

  const openingAnchor = balances.find((b) => b.kind === "opening");

  // A card that dates its lines by *transaction* date while striking its
  // balances by *posting* date prints rows older than the period they belong
  // to: an Apple Card statement for Jul 1–31 lists the Jun 30 purchases that
  // posted on Jul 1, which the "as of Jun 30" opening balance rightly excludes.
  // Left alone those rows sit on or before the opening anchor, fall outside the
  // `(opening, closing]` window every downstream check uses, and the period
  // reports a gap the size of their sum while the extraction itself ties out
  // perfectly. The statement is the authority on which period a line belongs
  // to, so pull a stray row forward to the first day the window covers.
  //
  // The boundary is the anchor's own day + 1, not the printed period start:
  // those coincide on a normal statement, but deriving it from the anchor is
  // what guarantees a clamped row can never land back outside the window and
  // trip the stranded-row check below. Only the near end ever spills — a
  // statement's last line is always inside its period — so this cannot reach
  // into the next month. The printed date rides along as `matchDate`, so the
  // ledger is still matched on what the statement actually said and a multi-day
  // pull can't push a row past `STATEMENT_MATCH_WINDOW_DAYS` and offer an
  // already-recorded charge as missing.
  const windowStart = openingAnchor ? addDays(openingAnchor.date, 1) : statementStart;
  if (windowStart) {
    for (const t of transactions) {
      if (t.date < windowStart) {
        t.matchDate = t.date;
        t.date = windowStart;
      }
    }
  }

  // A statement is self-checking: the lines it prints must account for exactly
  // the distance between the two balances it prints. AI extraction of a long
  // statement drops and mis-signs the odd row, and neither shows up anywhere
  // downstream — the close just quietly fails to reconcile, and `diagnose` then
  // blames the ledger for a gap the import invented. Do the arithmetic here,
  // where the printed answer is still at hand, and refuse to be silent about it.
  const opening = openingAnchor;
  const closing = balances.find((b) => b.kind === "closing");
  if (!balanceOnly && opening && closing && transactions.length > 0) {
    const net = transactions.reduce((n, t) => n + t.amountCents, 0);
    const expected = closing.balanceCents - opening.balanceCents;
    if (net !== expected) {
      problems.push(
        `These rows do not tie out to the printed balances: ${transactions.length} transactions net ${formatCents(net)}, but the balances move ${formatCents(expected)} — off by ${formatCents(net - expected)}. A line was missed or given the wrong sign; check before committing.`,
      );
    }

    // Tying out is not enough: a row can carry the right amount and a date the
    // period never covers — a misread year is the usual cause — and it then
    // lands outside `(opening, closing]` and goes uncounted no matter how well
    // the totals agree. The clamp above rescues rows that fall short of the
    // period; nothing rescues one that falls past its end, so say so here.
    const stranded = transactions.filter(
      (t) => t.date <= opening.date || t.date > closing.date,
    );
    if (stranded.length > 0) {
      const dates = [...new Set(stranded.map((t) => t.date))].sort();
      problems.push(
        `${stranded.length} transaction${stranded.length === 1 ? " falls" : "s fall"} outside the period this statement covers (${opening.date} → ${closing.date}) and will not count toward it: ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? `, +${dates.length - 5} more` : ""}. Check the dates before committing.`,
      );
    }
  }

  // A debt statement whose balances came back positive almost certainly lost a
  // sign in extraction — flag rather than silently negate, since a genuine
  // credit balance is possible.
  if (owed && balances.length > 0 && balances.every((b) => b.balanceCents > 0)) {
    problems.push(
      `Every balance on this ${kindNoun} statement came back positive — check the sign before committing (money owed should be negative).`,
    );
  }

  return {
    transactions,
    balances,
    statementStart,
    statementEnd,
    accountLastFour: raw.accountLastFour?.trim().slice(-4) || null,
    problems,
  };
}
