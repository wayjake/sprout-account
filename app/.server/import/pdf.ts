import { z } from "zod";
import { chatJSON, pdfModel } from "~/.server/openrouter";
import { ACCOUNT_TYPE_LABELS, isLiability } from "~/lib/accounts";
import { parseCentsString } from "~/lib/money";
import { addDays } from "~/lib/dates";
import type { AccountKind, AccountType } from "~/db/schema";

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
  transactions: { date: string; description: string; amountCents: number }[];
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
  const balanceOnly = account.kind === "balance";
  const owed = isLiability(account.accountType);
  const kindNoun = ACCOUNT_TYPE_LABELS[account.accountType].toLowerCase();

  const raw = await chatJSON({
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
- accountLastFour: the last four digits of the account number if printed, else null.`,
    user: [
      { type: "text", text: `Extract from this statement (${filename}).` },
      {
        type: "file",
        file: {
          filename,
          file_data: `data:application/pdf;base64,${buffer.toString("base64")}`,
        },
      },
    ],
    schema: ExtractionSchema,
    schemaName: "statement_extraction",
  });

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
