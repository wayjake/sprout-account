import { z } from "zod";
import { chatJSON, pdfModel } from "~/.server/openrouter";
import { firstPageOnly } from "~/.server/import/pdf-split";
import {
  ACCOUNT_TYPE_LABELS,
  isAccountType,
  resolveAccountKind,
} from "~/lib/accounts";
import { ACCOUNT_TYPES, type AccountKind, type AccountType } from "~/db/schema";

/**
 * Reading a statement's cover before reading its contents.
 *
 * `extractFromPdf` needs an account before it can start — the prompt it builds
 * turns on whether the account is a debt (so a balance owed is negative), and
 * on whether it keeps a ledger at all (so transactions are wanted). That is
 * fine when the account already exists, and a dead end when it doesn't: a
 * statement for an account nobody has created yet has nowhere to go, and the
 * only thing that could say what to create is the statement.
 *
 * So identity comes first, off page 1 alone, where the institution, the account
 * number and the period are printed and none of the rows are.
 */

const IdentitySchema = z.object({
  institutionName: z.string().nullable(),
  accountName: z.string().nullable(),
  /**
   * What a person would call this account in a list, as against what the
   * statement prints. Only ever used to *name* a created account — never a
   * matching probe, so it is allowed to draw on the folder path.
   */
  displayName: z.string().nullable(),
  /**
   * Who the statement is addressed to, as printed. The one signal that tells
   * two family cards from the same issuer apart — an Apple Card statement
   * prints no number, but its every page is headed with the holder's name.
   */
  accountHolder: z.string().nullable(),
  accountLastFour: z.string().nullable(),
  /** One of ACCOUNT_TYPES, or null when the page doesn't make it clear */
  accountType: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  /**
   * Whether the statement itemizes transactions, as against reporting a value
   * or a balance only. What separates a brokerage statement from a bank one.
   */
  listsTransactions: z.boolean(),
});

export interface StatementIdentification {
  institutionName: string | null;
  accountName: string | null;
  displayName: string | null;
  accountHolder: string | null;
  accountLastFour: string | null;
  accountType: AccountType | null;
  periodStart: string | null;
  periodEnd: string | null;
  listsTransactions: boolean;
}

const isoDate = (s: string | null): string | null =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;

/** Whose account is this, and what kind? One cheap call against page 1. */
export async function identifyStatement(
  buffer: Buffer,
  filename: string,
): Promise<StatementIdentification> {
  const page = await firstPageOnly(buffer);
  const raw = await chatJSON({
    model: pdfModel(),
    system: `You are reading the first page of a financial statement to work out whose account it is. You are NOT extracting transactions.

- institutionName: the bank, card issuer, brokerage or lender whose statement this is, as printed ("Chase", "Fidelity", "Wells Fargo"). Null if not shown.
- accountName: what this particular account is called on the statement ("Premier Checking", "Sapphire Preferred", "Roth IRA"). Never the account holder's name, and never the institution repeated. Null if not shown. Report it exactly as printed — do not clean it up; this field is matched verbatim against other statements.
- displayName: the short, human-readable name a person would give this account in a list of the household's accounts — title case, 2–4 words, no ®/™ marks, no marketing boilerplate ("Preferred Rewards Gold EveryDay Signature Card" → "Gold EveryDay Card"). Build it from words the statement prints. One exception: when the product name alone could belong to anyone in a household (a store card, an Apple Card), lead with the holder's first name ("Becca's Apple Card") — from accountHolder when the page prints one, else from the file's folder path if that names a person. Null when accountName already reads that way.
- accountHolder: the person or people the statement is addressed to, exactly as printed, including an email address when one accompanies the name ("Jacob Berg, jake@example.com"). This is the customer named in the page header or address block — never a guess from the filename. Null if no holder is printed.
- accountLastFour: the last four digits of the account or card number. Null if not shown.
- accountType: exactly one of ${ACCOUNT_TYPES.join(", ")}, or null if the page does not make it clear. Judge by what the statement is: a card statement with a credit limit and a minimum payment is credit_card; a HELOC or revolving credit line is line_of_credit; a home loan with principal and escrow is mortgage; another amortizing loan is loan; a brokerage or taxable investment account is investment; an IRA, 401k or pension is retirement.
- periodStart / periodEnd: the statement period as YYYY-MM-DD, or null.
- listsTransactions: true when the statement itemizes individual transactions somewhere in it, false when it only reports balances or holdings. A brokerage or retirement statement is usually false; a bank or card statement is true.

Report only what the page shows. Never guess an account number.`,
    user: [
      { type: "text", text: `Identify the account this statement belongs to (${filename}).` },
      {
        type: "file",
        file: {
          filename,
          file_data: `data:application/pdf;base64,${page.toString("base64")}`,
        },
      },
    ],
    schema: IdentitySchema,
    schemaName: "statement_identity",
  });

  const lastFour = raw.accountLastFour?.replace(/\D/g, "").slice(-4) ?? "";
  return {
    institutionName: raw.institutionName?.trim() || null,
    accountName: raw.accountName?.trim() || null,
    displayName: raw.displayName?.trim() || null,
    accountHolder: raw.accountHolder?.trim() || null,
    accountLastFour: /^\d{4}$/.test(lastFour) ? lastFour : null,
    accountType: isAccountType(raw.accountType) ? raw.accountType : null,
    periodStart: isoDate(raw.periodStart),
    periodEnd: isoDate(raw.periodEnd),
    listsTransactions: raw.listsTransactions,
  };
}

export interface ProposedAccount {
  name: string;
  institution: string;
  accountType: AccountType;
  kind: AccountKind;
  lastFour: string | null;
}

/**
 * The account a statement is asking to have created.
 *
 * `kind` is never taken from the identification. It is derived through
 * `resolveAccountKind`, the one place that owns the rule — and the one place
 * that knows a loan is the only type where the answer is the user's to pick.
 * `listsTransactions` is allowed to settle that pick, since a statement that
 * itemizes draws and payments is exactly the line of credit worth importing
 * row by row, but only for the types that offer the choice.
 */
export function proposeAccountFromStatement(
  identity: StatementIdentification,
  filename?: string,
): ProposedAccount {
  const accountType = identity.accountType ?? "checking";
  const kind = resolveAccountKind(
    accountType,
    identity.listsTransactions ? "transaction" : "balance",
  );
  return {
    // Prefer the name a person would use over the name the statement prints —
    // but only as a *name*; matching against future statements still runs on
    // the printed accountName and lastFour, which is why `nameless` in
    // `settleAccount` ignores displayName: a name derived from a folder path
    // is not printed evidence to create an account from. A statement that
    // names neither the account nor the bank still has to become something a
    // person can recognise in a list, so fall back to the type's own label
    // rather than to an empty field.
    name: identity.displayName || identity.accountName || ACCOUNT_TYPE_LABELS[accountType],
    institution: identity.institutionName || fallbackInstitution(filename),
    accountType,
    kind,
    lastFour: identity.accountLastFour,
  };
}

/** Last resort for the institution: the leading word of the filename. */
function fallbackInstitution(filename?: string): string {
  const stem = (filename ?? "").replace(/\.[^.]+$/, "");
  const word = stem.split(/[^A-Za-z]+/).find((w) => w.length >= 3);
  if (!word) return "Unknown";
  return word[0].toUpperCase() + word.slice(1);
}
