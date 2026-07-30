import { ACCOUNT_TYPES, type AccountType } from "~/db/schema";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  investment: "Investment",
  retirement: "Retirement",
  other: "Other",
};

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/**
 * Investment and retirement accounts are tracked by balance snapshots from
 * statements; everything else is tracked transaction by transaction. The
 * account's `kind` is derived from its type, never chosen separately.
 */
export function kindForAccountType(accountType: AccountType) {
  return accountType === "investment" || accountType === "retirement"
    ? ("balance" as const)
    : ("transaction" as const);
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
