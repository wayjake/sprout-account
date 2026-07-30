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
import { accountLabel, matchAccountByHint } from "~/lib/accounts";
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
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * Take one uploaded file as far as it can go on its own: work out which account
 * it belongs to, pull the rows out of it, and stage them. Files needing a
 * column mapping stop at that step and wait for the user.
 *
 * Never throws for per-file problems — a bad file in a ten-file upload returns
 * an error result and lets the rest through.
 */
export async function intakeFile(input: {
  sessionId: number;
  file: File;
  defaultAccount: Account;
  accounts: Account[];
}): Promise<IntakeResult> {
  const { sessionId, file, defaultAccount, accounts } = input;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileHash = sha256(buffer);

    // First guess from the filename; a PDF may overrule it with the account
    // number printed on the statement.
    const fromName = matchAccountByHint(accounts, file.name);
    let account = fromName?.account ?? defaultAccount;
    let assignment = fromName ? `From filename — ${fromName.reason}` : null;

    const prior = await findPriorCommit(fileHash);
    const priorWarning = prior
      ? `This exact file was already imported as "${prior.filename}" (batch #${prior.id}).`
      : null;

    if (isPdf(file)) {
      const extraction = await extractFromPdf(buffer, file.name, account);

      // The statement's own account number beats a filename guess
      if (extraction.accountLastFour) {
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
      if (!hasTxns && !hasBalances) {
        const batch = await createBatch({
          sessionId,
          accountId: account.id,
          accountLabel: accountLabel(account),
          kind: account.kind === "balance" ? "balances" : "statement",
          sourceType: "pdf",
          filename: file.name,
          fileHash,
          status: "review",
          statsJson: JSON.stringify({
            priorWarning,
            accountAssignment: assignment,
            extractionProblems: extraction.problems,
          }),
        });
        return {
          filename: file.name,
          batchId: batch.id,
          outcome: "review",
          accountId: account.id,
          accountAssignment: assignment,
        };
      }

      const batch = await createBatch({
        sessionId,
        accountId: account.id,
        accountLabel: accountLabel(account),
        kind: hasTxns && hasBalances ? "statement" : hasTxns ? "transactions" : "balances",
        sourceType: "pdf",
        filename: file.name,
        fileHash,
        status: "review",
        statsJson: JSON.stringify({
          priorWarning,
          accountAssignment: assignment,
          extractionProblems: extraction.problems,
          statementPeriod:
            extraction.statementStart && extraction.statementEnd
              ? { start: extraction.statementStart, end: extraction.statementEnd }
              : null,
        }),
      });
      await stageBatchRows(batch.id, account.id, {
        txns: extraction.transactions.map((t, i) => ({ ...t, rowIndex: i })),
        balances: extraction.balances.map((b, i) => ({ ...b, rowIndex: i })),
      });
      await addOverlapWarning(batch.id, account.id);
      return {
        filename: file.name,
        batchId: batch.id,
        outcome: "review",
        accountId: account.id,
        accountAssignment: assignment,
      };
    }

    // --- CSV ---
    const text = buffer.toString("utf-8");
    const { headers, records } = parseCsv(text);
    if (headers.length === 0 || records.length === 0) {
      return {
        filename: file.name,
        batchId: null,
        outcome: "error",
        accountId: null,
        accountAssignment: null,
        error: "Could not parse any rows from this CSV.",
      };
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
    return {
      filename: file.name,
      batchId: null,
      outcome: "error",
      accountId: null,
      accountAssignment: null,
      error:
        err instanceof AiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not read this file.",
    };
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
  await db
    .update(schema.importBatches)
    .set({
      statsJson: JSON.stringify({ ...stats, accountAssignment: "Chosen by hand" }),
    })
    .where(eq(schema.importBatches.id, batchId));
  await addOverlapWarning(batchId, accountId);
}
