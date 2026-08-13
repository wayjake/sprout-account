import { z } from "zod";
import { chatJSON, pdfModel } from "~/.server/openrouter";
import { mapWithConcurrency, splitPdfPages, type PdfChunk } from "~/.server/import/pdf-split";
import { auditTransactionsFromText, balancesFromText } from "~/.server/import/pdf-text";
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
  /** The bank or brokerage whose name is on the statement */
  institutionName: z.string().nullable(),
  /** What the statement calls this account ("Premier Checking") */
  accountName: z.string().nullable(),
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
      /** Null when the statement prints the figure with no date of its own — see `finalize` */
      date: z.string().nullable(),
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
  institutionName: string | null;
  accountName: string | null;
  problems: string[];
  /**
   * The extraction contradicts itself — the rows do not account for the
   * distance between the printed balances, or some of them fall outside the
   * period. Committing anyway puts wrong rows in the ledger and leaves
   * `diagnose` blaming the books for a gap the import invented, so an
   * unattended run holds the file instead of deciding for itself.
   */
  blocked: boolean;
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
  // Deliberately one AI pass. A merged statement that fails the tie-out check
  // below is not a dice roll worth repeating: every failure observed was
  // structural — signs flipped on a statement thick with returns — and a second
  // pass reproduced it while doubling the work for exactly the longest
  // statements, the ones most likely to fail.
  const merged = mergeRaw(raws);
  if (account.kind !== "balance") await fillMissingBalances(merged, buffer);
  const result = finalize(merged, account);

  // The one retry that isn't a dice roll: a deterministic parse of the PDF's
  // own text layer, accepted only when its rows explain the printed balance
  // movement to the cent (`auditTransactionsFromText`). This rescues both a
  // numerical mismatch and an AI response that omitted a period or anchor —
  // the latter otherwise looks "clean" only because there is nothing left to
  // check it against. A failed audit changes nothing, so the hold still lands
  // on the close screen for anything the text layer cannot vouch for.
  if (account.kind !== "balance") {
    const owed = isLiability(account.accountType);
    const raw = (kind: string) =>
      parseCentsString(merged.balances.find((b) => b.kind?.toLowerCase() === kind)?.balance ?? "");
    const opening = raw("opening");
    const closing = raw("closing");
    const incomplete =
      opening == null ||
      closing == null ||
      !merged.statementStart ||
      !merged.statementEnd;
    if (result.blocked || incomplete) {
      const audited = await auditTransactionsFromText(
        buffer,
        opening != null && closing != null ? closing - opening : null,
        {
          layout: owed ? "signed" : "columnar",
          period: { start: merged.statementStart, end: merged.statementEnd },
        },
      );
      if (audited) {
        // The text layer can recover summary figures as well as cycle bounds.
        // A liability's values remain in printed (amount-owed) terms here;
        // finalize translates both them and the audited rows together.
        const repairedBalances =
          audited.period && audited.balances
            ? [
                {
                  date: audited.period.start,
                  balance: audited.balances.opening,
                  kind: "opening",
                },
                {
                  date: audited.period.end,
                  balance: audited.balances.closing,
                  kind: "closing",
                },
              ]
            : audited.period
              ? merged.balances.map((balance) => ({
                  ...balance,
                  date:
                    balance.kind?.toLowerCase() === "opening"
                      ? audited.period!.start
                      : audited.period!.end,
                }))
              : merged.balances;
        const repaired = {
          ...merged,
          statementStart: audited.period?.start ?? merged.statementStart,
          statementEnd: audited.period?.end ?? merged.statementEnd,
          transactions: audited.transactions,
          balances: repairedBalances,
        };
        const second = finalize(repaired, account);
        if (!second.blocked) return second;
      }
    }
  }
  return result;
}

type RawExtraction = z.infer<typeof ExtractionSchema>;

/**
 * Fold the chunks back into the shape a single request would have produced, so
 * everything downstream is unaware the statement was ever split. Transactions
 * concatenate in page order, which is document order. The period, the account's
 * identity and the balances are printed once, on the first page that carries
 * them, so the first chunk to report each wins — a later chunk repeating a
 * figure out of a running total cannot displace the printed one.
 *
 * Every scalar the extraction returns has to be listed here. One left out does
 * not fall back to a later chunk's answer, it vanishes — and only on statements
 * past `SPLIT_ABOVE_PAGES`, which are exactly the ones long enough to be worth
 * identifying.
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
    institutionName: raws.find((r) => r.institutionName)?.institutionName ?? null,
    accountName: raws.find((r) => r.accountName)?.accountName ?? null,
    transactions: raws.flatMap((r) => r.transactions),
    balances,
  };
}

/**
 * Fill in a balance the extraction came back without, from the statement's own
 * text layer. Both ends are needed for the statement to be checkable at all —
 * `finalize`'s tie-out is gated on having the pair, and the opening one is the
 * boundary its clamp works from — so a missing figure is not a small loss: it
 * is the difference between a statement that proves itself and one that only
 * looks clean. The model drops it most often when the page gives it no date to
 * report (American Express prints "Previous Balance" undated), which is a
 * failure of the schema's making, not of reading; the figure itself is sitting
 * on a labelled line the text layer reads exactly.
 *
 * Gaps only. A figure the model did report keeps its date and is left alone —
 * and if the two disagree, the tie-out check is what should say so. Printed
 * terms, like everything else on this path: `finalize` owns the translation to
 * household signs, which is why this is skipped for balance-only accounts,
 * whose figures are translated in the prompt instead.
 */
async function fillMissingBalances(merged: RawExtraction, buffer: Buffer) {
  const has = (kind: string) =>
    merged.balances.some((b) => (b.kind?.toLowerCase() === "opening" ? "opening" : "closing") === kind);
  if (has("opening") && has("closing")) return;

  const printed = await balancesFromText(buffer);
  if (!printed) return;
  // Undated on purpose — the text layer proves the figure, not the day it
  // belongs to. `finalize` places an undated balance from the period it can
  // see, which is the same judgement it already makes for the model's own.
  if (!has("opening")) {
    merged.balances.unshift({ date: null, balance: printed.opening, kind: "opening" });
  }
  if (!has("closing")) {
    merged.balances.push({ date: null, balance: printed.closing, kind: "closing" });
  }
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
   - Amounts are decimal strings.${
     owed
       ? ` Transcribe each amount EXACTLY as printed, sign included. A ${kindNoun} statement is written in amount-owed terms — purchases, charges, interest and fees print positive; payments, refunds, returns and dispute credits print with a minus sign. Copy the sign off the page; do NOT convert to any other convention. If the statement marks a credit with "CR", "CREDIT" or parentheses instead of a minus sign, write it with a leading minus.`
       : ` Sign convention: money leaving the account (purchases, fees, withdrawals, payments made) is NEGATIVE; money arriving (deposits, refunds, interest earned) is POSITIVE.`
   }
   - Skip running-balance columns, summary lines, subtotals and totals — individual transactions only.
   - A rewards figure printed on an ordinary purchase row — a rate and an amount such as "1%  $0.10" sitting in a Daily Cash or Rewards column beside the transaction amount — is cash back earned on that purchase. It belongs to that row and is NEVER a row of its own.
   - Indented sub-lines beneath a transaction are usually rewards *earned* (cash back, points, "3% Daily Cash at X", bonus offers). Those are not transactions — skip them. The exception is a reward *reversal* on a return or credit: a line whose own text names it an adjustment or reversal, such as a "Daily Cash Adjustment" shown at a negative rate under a return. That money is taken back from the account, so include it as its own row, dated like the line it sits under. Only a line that literally reads as an adjustment qualifies — never promote an earned-rewards figure into one. It is a charge, never a credit${
     owed
       ? ` — transcribed as printed, a "Daily Cash Adjustment" of $0.26 under a $26.46 return is "0.26" (it adds to what is owed), while the return above it is "-26.46"`
       : ""
   }.

2. The statement's opening and closing balances, into the balances array.
   - One entry with kind "opening" dated the first day of the statement period, one with kind "closing" dated the last day.
   - These are the "beginning balance" / "previous balance" and "ending balance" / "new balance" figures printed on the statement.
   - If a printed balance has no date of its own and the statement shows no period to take one from — American Express prints "Previous Balance" in the account summary with neither — return that entry with a null date. Report the figure; never drop it, and never invent a date for it.${
     owed
       ? `
   - Transcribe balances exactly as printed, like the transactions: a balance owed prints positive ("New balance $1,234.56" is "1234.56"); a credit (overpaid) balance prints with a minus sign or a CR mark — write that with a leading minus.`
       : ""
   }
   - If only one of the two is printed, return just that one. If neither is printed, return an empty balances array — never invent or compute one.`
}
- Dates must be YYYY-MM-DD. Infer the year from the statement period when a line omits it.
- statementStart/statementEnd: the statement period dates if shown, else null.
- accountLastFour: the last four digits of the account number if printed, else null.
- institutionName: the bank, card issuer or brokerage whose statement this is, as it appears on the page ("Chase", "Fidelity"). Null if not shown.
- accountName: what the statement calls this particular account ("Premier Checking", "Sapphire Preferred"). Not the account holder's name, and not the institution again. Null if not shown.${
      split
        ? `

You are being shown PAGES ${chunk.firstPage}–${chunk.lastPage} of a longer statement, not the whole document.
- Extract each row printed on these pages exactly once. The pages you cannot see are covered by their own extract, so never reach for a row that is not here, and never invent or repeat one — a row that does not appear on these pages is not missing, it is simply somebody else's.
- Balances, the statement period and the account's identity are printed once, usually on page 1. If these pages do not show them, return an empty balances array and null for the period, the account number, the institution and the account name. Do not infer a balance from a running total and never compute one.
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
  // Problems that mean the extraction disagrees with itself, as opposed to a
  // row that could not be read at all. Only these hold up an unattended commit.
  let blocked = false;
  const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  // A debt statement is extracted in its own printed terms — charges positive,
  // credits negative — and translated to household signs here, in one place.
  // The model used to be asked to translate, and on a statement thick with
  // identical printed-negative credits it would drift into copying the page's
  // sign mid-document, chunk by chunk (measured: 53 dispute credits flipped on
  // one Apple Card statement, a different count on the rerun). Transcription is
  // the behaviour it reliably has; the convention now lives in this negation.
  // Balance-only statements keep the translate-in-prompt contract, so only the
  // transaction-statement path flips.
  const flip = owed && !balanceOnly;

  const transactions: PdfExtractionResult["transactions"] = [];
  for (const t of raw.transactions) {
    const amountCents = parseCentsString(t.amount);
    if (amountCents == null || !isoDate(t.date)) {
      problems.push(`Skipped row: ${t.date} ${t.description} ${t.amount}`);
      continue;
    }
    transactions.push({
      date: t.date,
      description: t.description,
      amountCents: flip ? -amountCents : amountCents,
    });
  }

  const statementStart =
    raw.statementStart && isoDate(raw.statementStart) ? raw.statementStart : null;
  const statementEnd = raw.statementEnd && isoDate(raw.statementEnd) ? raw.statementEnd : null;

  const txnDates = transactions.map((t) => t.date).sort();

  // Not every statement prints its period, so fall back to the first day it
  // actually shows a transaction on — either way this is the day the opening
  // balance is "as of", and the only date we should move.
  const periodStart = statementStart ?? txnDates[0] ?? null;
  const periodEnd = statementEnd ?? txnDates.at(-1) ?? null;

  const balances: PdfExtractionResult["balances"] = [];
  for (const b of raw.balances) {
    const balanceCents = parseCentsString(b.balance);
    const kind = b.kind?.toLowerCase() === "opening" ? "opening" : "closing";
    const printed = b.date && isoDate(b.date) ? b.date : null;

    // Anchors are end-of-day figures everywhere downstream: a window spans
    // (previous anchor, this anchor] and activity counts from the day *after*
    // an anchor. A statement's opening balance is the opposite — it is the
    // figure *before* the first day's transactions post. Left on the period's
    // first day it silently swallows that day's rows, so move it back a day,
    // where it also lines up exactly with the prior statement's closing anchor.
    //
    // A balance the statement printed undated has to be placed here instead.
    // American Express gives "Previous Balance" no date and prints no period at
    // all, so the model has nothing to date it with and used to drop the entry:
    // the statement then carried a closing anchor and no opening one, which
    // reads as clean only because the tie-out check below is gated on having
    // both, and the clamp that follows has no boundary to work from. Every
    // month then failed against the month before it — measured on a folder of
    // eight Amex statements, three periods that reconcile perfectly on paper.
    //
    // An undated opening goes on the first day the statement shows activity,
    // and deliberately *not* the day before it. The shift above is right for a
    // printed period start, whose first day is by definition the first day
    // activity can post. It is wrong here: a card that dates its lines by
    // transaction date resumes on the very day its previous statement closed
    // (Amex closes 12/07 with its last line on 12/06, and the next statement's
    // first line is 12/07). Anchoring on that day puts this opening on or after
    // the previous statement's closing anchor, never before it, and the clamp
    // below then carries the day's rows forward into the window that should
    // hold them. What is left between the two statements is a window holding no
    // rows from either — so it reconciles when the two figures agree and
    // reports a gap when they don't, which is the whole job. A day earlier and
    // those rows are stranded in that window instead, off by their own sum.
    const date =
      printed == null
        ? kind === "opening"
          ? (txnDates[0] ?? null)
          : periodEnd
        : kind === "opening" && periodStart && printed === periodStart
          ? addDays(printed, -1)
          : printed;

    if (balanceCents == null || date == null) {
      problems.push(`Skipped balance: ${b.date ?? "undated"} ${b.balance}`);
      continue;
    }
    balances.push({ date, balanceCents: flip ? -balanceCents : balanceCents, kind });
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
      blocked = true;
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
      blocked = true;
      const dates = [...new Set(stranded.map((t) => t.date))].sort();
      problems.push(
        `${stranded.length} transaction${stranded.length === 1 ? " falls" : "s fall"} outside the period this statement covers (${opening.date} → ${closing.date}) and will not count toward it: ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? `, +${dates.length - 5} more` : ""}. Check the dates before committing.`,
      );
    }
  }

  // A debt statement whose balances come out positive after the flip means the
  // model ignored the transcribe instruction and translated to household signs
  // anyway (printed-negative balances), which the flip then inverted — flag
  // rather than silently re-negate, since a genuine credit balance is possible.
  // This is also the only check that can catch a *consistently* translated
  // extraction: with every sign inverted, rows and balances still tie out.
  if (owed && balances.length > 0 && balances.every((b) => b.balanceCents > 0)) {
    blocked = true;
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
    institutionName: raw.institutionName?.trim() || null,
    accountName: raw.accountName?.trim() || null,
    problems,
    blocked,
  };
}
