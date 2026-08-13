import { eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { headerSignature, parseCsv } from "~/.server/import/csv";
import { findSavedMapping, suggestMapping } from "~/.server/import/mapping";
import { extractFromPdf } from "~/.server/import/pdf";
import {
  createBatch,
  findOverlappingBatches,
  findPriorCommit,
  restageBatchAccount,
  saveUpload,
  sha256,
  stageBatchRows,
} from "~/.server/import/stage";
import { AiError } from "~/.server/openrouter";
import {
  accountLabel,
  matchAccountByHint,
  matchAccountsByHint,
  type HintStrength,
} from "~/lib/accounts";
import { applyMapping } from "~/lib/csv-mapping";
import type { Account } from "~/db/schema";

export interface IntakeResult {
  filename: string;
  batchId: number | null;
  /** Where the file ended up: staged for review, awaiting a column mapping, or refused */
  outcome: "review" | "mapping" | "error";
  accountId: number | null;
  accountAssignment: string | null;
  error?: string;
  /** The extraction disagrees with the balances it printed — see `finalize`. */
  blocked?: boolean;
}

export function isPdf(file: { name: string; type?: string }): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * A file to take in. Uploads arrive as `File`; a bulk run has already written
 * its statements to disk and reads them back as bytes, and making it rebuild a
 * `File` around each one would copy every statement in memory for nothing.
 */
export type IntakeFile = File | { name: string; buffer: Buffer };

async function readIntake(file: IntakeFile) {
  const buffer =
    file instanceof File ? Buffer.from(await file.arrayBuffer()) : file.buffer;
  return { name: file.name, buffer };
}

function refused(filename: string, error: string): IntakeResult {
  return {
    filename,
    batchId: null,
    outcome: "error",
    accountId: null,
    accountAssignment: null,
    error,
  };
}

function intakeError(filename: string, err: unknown): IntakeResult {
  return refused(
    filename,
    err instanceof AiError
      ? err.message
      : err instanceof Error
        ? err.message
        : "Could not read this file.",
  );
}

/** The account a file belongs to, guessed from its name, and why. */
function accountFromFilename(accounts: Account[], filename: string, fallback: Account) {
  const hit = matchAccountByHint(accounts, filename);
  return {
    account: hit?.account ?? fallback,
    assignment: hit ? `From filename — ${hit.reason}` : null,
  };
}

/** What a statement says about whose account it is. */
export interface StatementIdentity {
  accountLastFour: string | null;
  institutionName: string | null;
  accountName: string | null;
  /** Who the statement is addressed to, as printed — see `identifyStatement`. */
  accountHolder?: string | null;
}

export type StatementAccountResolution =
  /** `strength` is which signal carried it — a caller acting unattended should
   *  treat an `institution` match as a lead, not an answer. */
  | { kind: "match"; account: Account; reason: string; strength: HintStrength }
  /** Several accounts fit equally well — a question, never a new account. */
  | { kind: "ambiguous"; candidates: Account[]; reason: string }
  | { kind: "none" };

/**
 * Which existing account a statement belongs to, on the evidence of what is
 * printed on it. Tried strongest first: the account number, then the name the
 * statement gives the account, then the institution — and the filename last,
 * since it is whatever the bank's download button happened to call the file.
 *
 * A tie is reported rather than discarded. "Apple Card" as an institution
 * matches both "Apple (Jake)" and "Apple (Becca)"; treating that as "no match"
 * is how a folder of Apple Card statements ended up creating a *third* Apple
 * account. Nothing matching and everything matching call for opposite
 * responses, so the caller has to be able to tell them apart.
 */
export function resolveStatementAccount(
  accounts: Account[],
  hints: StatementIdentity & { filename?: string },
): StatementAccountResolution {
  // An account that has learned its number can never be the account of a
  // statement that prints a different one. Excluding those up front is what
  // makes the weaker probes exact: without it, a name or institution hit lands
  // happily on a sibling account at the same bank — the case the numbers exist
  // to tell apart. An account with no number recorded stays in; it may just
  // not have learned its own yet.
  const printed = /^\d{4}$/.test(hints.accountLastFour ?? "") ? hints.accountLastFour : null;
  const candidates = printed
    ? accounts.filter((a) => !a.lastFour || a.lastFour === printed)
    : accounts;

  const probes: { text: string; source: string }[] = [
    { text: hints.accountLastFour ?? "", source: "the statement" },
    { text: hints.accountName ?? "", source: "the statement" },
    { text: hints.institutionName ?? "", source: "the statement" },
    { text: hints.filename ?? "", source: "filename" },
  ];
  let weak: Extract<StatementAccountResolution, { kind: "match" }> | null = null;
  let tie: Extract<StatementAccountResolution, { kind: "ambiguous" }> | null = null;
  for (const probe of probes) {
    if (!probe.text) continue;
    const hit = matchAccountsByHint(candidates, probe.text);
    if (hit.kind === "match") {
      if (hit.strength !== "institution") {
        return {
          kind: "match",
          account: hit.account,
          reason: `From ${probe.source} — ${hit.reason}`,
          strength: hit.strength,
        };
      }
      // An institution names a bank, not an account. Hold it rather than
      // return it: a later probe or the printed holder below may still land
      // something exact, and the caller treats an institution match as a lead
      // to be corroborated, not an answer.
      if (!weak) {
        weak = {
          kind: "match",
          account: hit.account,
          reason: `From ${probe.source} — ${hit.reason}`,
          strength: hit.strength,
        };
      }
    }
    // Keep looking — a weaker probe can still land an outright match, and one
    // often does. The first tie is only the answer if nothing else works out.
    if (hit.kind === "ambiguous" && !tie) {
      tie = {
        kind: "ambiguous",
        candidates: hit.candidates,
        reason: `${probe.text.trim()} fits ${hit.candidates.length} accounts equally well`,
      };
    }
  }

  // The holder printed on the statement decides what the probes above could
  // not: "Apple Card" fits both family cards, "Jacob" fits one — and a
  // statement that prints no number at all often prints its holder on every
  // page. But the holder is only ever a tiebreaker, never evidence on its
  // own: nearly every statement in a household is addressed to the same one
  // or two people, so the first statement from an institution with no
  // account on file must not land on an unrelated account that happens to
  // carry the holder's name — a Robinhood card addressed to Jake is not
  // "Jake's Apple Card". The holder therefore chooses only among accounts
  // some other probe already implicated: it confirms the lone institution
  // hit or breaks a tie, and when nothing else matched anything, it decides
  // nothing. A word of the printed holder — a name, or the local part of an
  // email — appearing in exactly one implicated account's name settles the
  // match. Anything else (no word hits, or a word two names share) changes
  // nothing, and generic email furniture is excluded so "…@x.com" can't hit
  // an account with "com" somewhere in its name.
  if (hints.accountHolder) {
    const implicated = new Map<number, Account>();
    for (const a of tie?.candidates ?? []) implicated.set(a.id, a);
    if (weak) implicated.set(weak.account.id, weak.account);
    const words = hints.accountHolder
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !/^(com|net|org|edu|www|mail|email)$/.test(w));
    const byHolder = [...implicated.values()].filter((a) =>
      words.some((w) => a.name.toLowerCase().includes(w)),
    );
    if (byHolder.length === 1) {
      return {
        kind: "match",
        account: byHolder[0],
        reason: `From the statement — addressed to the holder of "${byHolder[0].name}"`,
        strength: "name",
      };
    }
  }

  return weak ?? tie ?? { kind: "none" };
}

/**
 * Take one uploaded PDF statement as far as it can go: work out which account
 * it belongs to, extract its transactions and bracketing balances, and stage
 * them for a month-end close. Transaction rows are matched against the ledger
 * rather than deduped into it — the close adds only what the books are missing.
 *
 * Never throws for per-file problems — a bad file in a ten-file upload returns
 * an error result and lets the rest through.
 */
export async function intakeStatement(input: {
  sessionId: number;
  file: IntakeFile;
  defaultAccount: Account;
  accounts: Account[];
  /**
   * The account this statement belongs to, already settled by the caller. A
   * bulk run resolves the account from a cheap identify pass — and may have
   * created it — before it gets here, so there is nothing left to guess.
   */
  account?: Account;
  accountAssignment?: string | null;
}): Promise<IntakeResult> {
  const { sessionId, defaultAccount, accounts } = input;
  if (!isPdf(input.file)) {
    return refused(
      input.file.name,
      "Only PDF statements belong in a month-end close — send transaction exports to Transaction Import.",
    );
  }

  const { name: filename, buffer } = await readIntake(input.file);
  try {
    const fileHash = sha256(buffer);

    let account = input.account ?? defaultAccount;
    let assignment = input.account
      ? (input.accountAssignment ?? null)
      : accountFromFilename(accounts, filename, defaultAccount).assignment;
    if (!input.account) {
      account = accountFromFilename(accounts, filename, defaultAccount).account;
    }

    const prior = await findPriorCommit(fileHash);
    const priorWarning = prior
      ? `This exact statement was already used in a close as "${prior.filename}" (batch #${prior.id}).`
      : null;

    const extraction = await extractFromPdf(buffer, filename, account);

    // The statement's own account number beats a filename guess — but not a
    // caller who has already settled the question.
    if (!input.account && extraction.accountLastFour) {
      const fromStatement = matchAccountByHint(accounts, extraction.accountLastFour);
      if (fromStatement && fromStatement.account.id !== account.id) {
        account = fromStatement.account;
        assignment = `From the statement — ${fromStatement.reason}`;
      } else if (fromStatement) {
        assignment = `Confirmed by the statement — ${fromStatement.reason}`;
      }
    }

    const hasTxns = extraction.transactions.length > 0;
    const hasBalances = extraction.balances.length > 0;
    const batch = await createBatch({
      sessionId,
      accountId: account.id,
      accountLabel: accountLabel(account),
      kind:
        hasTxns && hasBalances
          ? "statement"
          : hasTxns
            ? "transactions"
            : "balances",
      sourceType: "pdf",
      filename,
      fileHash,
      status: "review",
      statsJson: JSON.stringify({
        priorWarning,
        accountAssignment: assignment,
        extractionProblems: extraction.problems,
        extractionBlocked: extraction.blocked,
        // Kept rather than used and dropped: this is what lets a hand
        // correction teach the account its number (`reassignBatch`), and what
        // a "create the account from this statement" offer is filled in from.
        identity: {
          accountLastFour: extraction.accountLastFour,
          institutionName: extraction.institutionName,
          accountName: extraction.accountName,
        },
        statementPeriod:
          extraction.statementStart && extraction.statementEnd
            ? { start: extraction.statementStart, end: extraction.statementEnd }
            : null,
      }),
    });

    if (hasTxns || hasBalances) {
      await stageBatchRows(batch.id, account.id, {
        txns: extraction.transactions.map((t, i) => ({ ...t, rowIndex: i })),
        balances: extraction.balances.map((b, i) => ({ ...b, rowIndex: i })),
        matchLedger: true,
      });
      await addOverlapWarning(batch.id, account.id);
    }

    return {
      filename,
      batchId: batch.id,
      outcome: "review",
      accountId: account.id,
      accountAssignment: assignment,
      blocked: extraction.blocked,
    };
  } catch (err) {
    return intakeError(filename, err);
  }
}

/**
 * Take one uploaded transaction export as far as it can go: work out which
 * account it belongs to, map its columns, and stage the rows. Files needing a
 * column mapping stop at that step and wait for the user.
 *
 * Never throws for per-file problems — a bad file in a ten-file upload returns
 * an error result and lets the rest through.
 */
export async function intakeTransactions(input: {
  sessionId: number;
  file: File;
  defaultAccount: Account;
  accounts: Account[];
}): Promise<IntakeResult> {
  const { sessionId, file, defaultAccount, accounts } = input;
  if (isPdf(file)) {
    return refused(
      file.name,
      "PDF statements are read during a month-end close, not imported here — upload it on the Monthly Reconcile screen.",
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileHash = sha256(buffer);

    const { account, assignment } = accountFromFilename(
      accounts,
      file.name,
      defaultAccount,
    );

    const prior = await findPriorCommit(fileHash);
    const priorWarning = prior
      ? `This exact file was already imported as "${prior.filename}" (batch #${prior.id}).`
      : null;

    const text = buffer.toString("utf-8");
    const { headers, records } = parseCsv(text);
    if (headers.length === 0 || records.length === 0) {
      return refused(file.name, "Could not parse any rows from this CSV.");
    }

    const kind = account.kind === "balance" ? ("balances" as const) : ("transactions" as const);
    const signature = headerSignature(headers);
    const saved = await findSavedMapping(account.id, signature);

    if (saved) {
      const { txns, balances, errors } = applyMapping(records, saved, kind);
      const batch = await createBatch({
        sessionId,
        accountId: account.id,
        accountLabel: accountLabel(account),
        kind:
          txns.length > 0 && balances.length > 0
            ? "statement"
            : balances.length > 0
              ? "balances"
              : "transactions",
        sourceType: "csv",
        filename: file.name,
        fileHash,
        status: "review",
        statsJson: JSON.stringify({
          priorWarning,
          accountAssignment: assignment,
          rowErrors: errors.slice(0, 20),
        }),
      });
      await stageBatchRows(batch.id, account.id, { txns, balances });
      await addOverlapWarning(batch.id, account.id);
      return {
        filename: file.name,
        batchId: batch.id,
        outcome: "review",
        accountId: account.id,
        accountAssignment: assignment,
      };
    }

    // No saved mapping — suggest one and park the file at the mapping step
    const suggestion = await suggestMapping(headers, records.slice(0, 15), kind);
    const batch = await createBatch({
      sessionId,
      accountId: account.id,
      accountLabel: accountLabel(account),
      kind,
      sourceType: "csv",
      filename: file.name,
      fileHash,
      status: "mapping",
      statsJson: JSON.stringify({
        priorWarning,
        accountAssignment: assignment,
        suggestion: suggestion.mapping,
        suggestionSource: suggestion.source,
      }),
    });
    saveUpload(batch.id, buffer);
    return {
      filename: file.name,
      batchId: batch.id,
      outcome: "mapping",
      accountId: account.id,
      accountAssignment: assignment,
    };
  } catch (err) {
    return intakeError(file.name, err);
  }
}

/** Flag earlier committed imports covering the same dates for this account. */
export async function addOverlapWarning(batchId: number, accountId: number) {
  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, batchId),
  });
  if (!batch?.periodStart || !batch.periodEnd) return;

  const overlaps = await findOverlappingBatches({
    accountId,
    periodStart: batch.periodStart,
    periodEnd: batch.periodEnd,
    excludeBatchId: batchId,
  });
  if (overlaps.length === 0) return;

  const stats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
  await db
    .update(schema.importBatches)
    .set({
      statsJson: JSON.stringify({
        ...stats,
        overlaps: overlaps.map((o) => ({
          id: o.id,
          filename: o.filename,
          periodStart: o.periodStart,
          periodEnd: o.periodEnd,
        })),
      }),
    })
    .where(eq(schema.importBatches.id, batchId));
}

/** Re-point a staged batch at a different account and refresh its warnings. */
export async function reassignBatch(batchId: number, accountId: number) {
  await restageBatchAccount(batchId, accountId);
  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, batchId),
  });
  if (!batch) return;
  const stats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
  delete stats.overlaps;
  const remembered = await rememberLastFour(accountId, stats?.identity?.accountLastFour);
  await db
    .update(schema.importBatches)
    .set({
      statsJson: JSON.stringify({
        ...stats,
        accountAssignment: remembered
          ? `Chosen by hand — remembered ··${remembered} for this account`
          : "Chosen by hand",
      }),
    })
    .where(eq(schema.importBatches.id, batchId));
  await addOverlapWarning(batchId, accountId);
}

/**
 * Teach an account the number printed on a statement the user has just pointed
 * at it. The strongest branch of `matchAccountByHint` tests the last four, so
 * an account without one can never match it — which is why the guess had to be
 * corrected by hand in the first place, and why every later statement from the
 * same bank would need correcting too.
 *
 * Only fills a blank. An account that already carries a number is not
 * overwritten on the strength of one file: a shared statement, or a card
 * reissued under a new number, would otherwise rewrite the account's identity
 * and orphan the matching of everything imported before it.
 *
 * Returns the number it stored, or null if it changed nothing.
 */
async function rememberLastFour(
  accountId: number,
  lastFour: unknown,
): Promise<string | null> {
  if (typeof lastFour !== "string" || !/^\d{4}$/.test(lastFour)) return null;
  const account = await db.query.accounts.findFirst({
    where: eq(schema.accounts.id, accountId),
  });
  if (!account || account.lastFour) return null;
  await db
    .update(schema.accounts)
    .set({ lastFour })
    .where(eq(schema.accounts.id, accountId));
  return lastFour;
}
