import { ACCOUNT_KINDS, ACCOUNT_TYPES, type AccountKind, type AccountType } from "~/db/schema";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  line_of_credit: "Line of credit",
  mortgage: "Mortgage",
  loan: "Loan",
  investment: "Investment",
  retirement: "Retirement",
  other: "Other",
};

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && (ACCOUNT_TYPES as readonly string[]).includes(value);
}

export function isAccountKind(value: unknown): value is AccountKind {
  return typeof value === "string" && (ACCOUNT_KINDS as readonly string[]).includes(value);
}

/**
 * Account types where the household owes money rather than owns it. Their
 * balances are negative, and a positive transaction is a payment or a credit
 * coming off the debt — never income.
 */
const LIABILITY_TYPES = new Set<AccountType>([
  "credit_card",
  "line_of_credit",
  "mortgage",
  "loan",
]);

export function isLiability(accountType: AccountType): boolean {
  return LIABILITY_TYPES.has(accountType);
}

/**
 * Whether the account's tracking mode is the user's to pick.
 *
 * Most types have one sensible answer: a chequing account is always a ledger
 * of transactions, an IRA is always a series of valuations. Debts are the
 * exception — a HELOC statement reads like a credit card and is worth
 * importing row by row, while a mortgage is usually just a principal balance
 * you record once a month. Both are legitimate, so loans ask.
 */
export function supportsKindChoice(accountType: AccountType): boolean {
  return accountType === "mortgage" || accountType === "loan" || accountType === "line_of_credit";
}

/**
 * The tracking mode for a type: investment and retirement accounts are tracked
 * by balance snapshots, ordinary spending accounts transaction by transaction.
 * For loans this is only the default — see `supportsKindChoice`.
 */
export function kindForAccountType(accountType: AccountType): AccountKind {
  if (accountType === "investment" || accountType === "retirement") return "balance";
  // An amortizing debt normally arrives as a monthly principal figure; a
  // revolving one arrives as a statement of draws and payments.
  if (accountType === "mortgage" || accountType === "loan") return "balance";
  return "transaction";
}

/** Resolve the tracking mode to store, honouring the user's pick where the type allows one. */
export function resolveAccountKind(
  accountType: AccountType,
  requested: unknown,
): AccountKind {
  if (supportsKindChoice(accountType) && isAccountKind(requested)) return requested;
  return kindForAccountType(accountType);
}

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  transaction: "Import transactions",
  balance: "Track balance only",
};

/**
 * The transfer category that fits a payment into this account — what the two
 * legs of a linked pair get named. Null for types that are not debts.
 */
export function paymentCategoryName(accountType: AccountType): string | null {
  if (accountType === "credit_card") return "Credit Card Payment";
  if (isLiability(accountType)) return "Loan Payment";
  return null;
}

/** "Chase · Checking ··1234" — the human label for an account, used in
 *  import history where the account is snapshotted rather than joined. */
export function accountLabel(account: {
  name: string;
  institution: string;
  lastFour?: string | null;
}): string {
  const parts = [account.institution, account.name].filter(Boolean);
  return `${parts.join(" · ")}${account.lastFour ? ` ··${account.lastFour}` : ""}`;
}

export interface AccountHintCandidate {
  id: number;
  name: string;
  institution: string;
  lastFour?: string | null;
}

/**
 * Guess which account a file belongs to from a filename or a statement's
 * printed account number. Used to route a multi-file upload; always shown to
 * the user as a changeable choice rather than applied silently.
 *
 * Returns null when the evidence is ambiguous — two accounts matching equally
 * well is no better than no match.
 */
export function matchAccountByHint<T extends AccountHintCandidate>(
  accounts: T[],
  hint: string,
): { account: T; reason: string } | null {
  const text = hint.toLowerCase();

  // Strongest signal: the account's last four as a standalone 4-digit run
  const withLastFour = accounts.filter((a) => a.lastFour && /^\d{4}$/.test(a.lastFour));
  const digitRuns = text.match(/\d+/g) ?? [];
  const fourDigitRuns = new Set(digitRuns.filter((d) => d.length === 4));
  // Also allow the tail of a longer masked number (…xxxx1234)
  const tails = new Set(digitRuns.filter((d) => d.length > 4).map((d) => d.slice(-4)));
  const byLastFour = withLastFour.filter(
    (a) => fourDigitRuns.has(a.lastFour!) || tails.has(a.lastFour!),
  );
  if (byLastFour.length === 1) {
    return { account: byLastFour[0], reason: `matched ··${byLastFour[0].lastFour}` };
  }

  // Next: the account name appearing in the text
  const byName = accounts.filter(
    (a) => a.name.length >= 4 && text.includes(a.name.toLowerCase()),
  );
  if (byName.length === 1) return { account: byName[0], reason: `matched "${byName[0].name}"` };

  // Weakest: the institution, only useful when it picks out exactly one account
  const byInstitution = accounts.filter(
    (a) => a.institution.length >= 3 && text.includes(a.institution.toLowerCase()),
  );
  if (byInstitution.length === 1) {
    return { account: byInstitution[0], reason: `matched ${byInstitution[0].institution}` };
  }

  return null;
}
