import { Form, Link, data, redirect, useFetcher, useNavigation } from "react-router";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { reconcileAccounts } from "~/.server/balances";
import { reassignBatch } from "~/.server/import/intake";
import {
  commitSession,
  dedupeSessionBatches,
  discardBatch,
  discardSession,
  pendingRowsForBatches,
} from "~/.server/import/stage";
import { importedRegisterSearch } from "~/.server/queries";
import { ReconcilePanel } from "~/components/reconciliation";
import { Button, Card, CardHeader, EmptyState, selectClass } from "~/components/ui";
import { formatDateRange } from "~/lib/dates";
import type { Route } from "./+types/import-session";

export function meta() {
  return [{ title: "Review Import · Sprout Account — Household Ledger" }];
}

const KIND_LABELS: Record<string, string> = {
  transactions: "transactions",
  balances: "balances",
  statement: "statement + balance",
  amazon_orders: "Amazon orders",
};

export async function loader({ params }: Route.LoaderArgs) {
  const sessionId = Number(params.sessionId);
  const session = await db.query.importSessions.findFirst({
    where: eq(schema.importSessions.id, sessionId),
  });
  if (!session) throw data("Import not found", { status: 404 });
  // A month-end close is reviewed on its own screen, which is the only one that
  // knows what to do with a matched statement line; a bulk run has a live one.
  if (session.purpose === "reconcile") throw redirect(`/reconcile/${sessionId}`);
  if (session.purpose === "bulk") throw redirect(`/import/bulk/${sessionId}`);

  const batches = await db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.sessionId, sessionId))
    .orderBy(asc(schema.importBatches.id));

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.isActive, true))
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);

  const batchIds = batches.map((b) => b.id);
  const counts =
    batchIds.length === 0
      ? []
      : await db
          .select({
            batchId: schema.stagedRows.batchId,
            rowKind: schema.stagedRows.rowKind,
            status: schema.stagedRows.status,
            supersededByBatchId: schema.stagedRows.supersededByBatchId,
            count: sql<number>`count(*)`,
          })
          .from(schema.stagedRows)
          .where(inArray(schema.stagedRows.batchId, batchIds))
          .groupBy(
            schema.stagedRows.batchId,
            schema.stagedRows.rowKind,
            schema.stagedRows.status,
            schema.stagedRows.supersededByBatchId,
          );

  const filenames = new Map(batches.map((b) => [b.id, b.filename]));
  const countsByBatch = new Map<
    number,
    {
      txnNew: number;
      txnDupe: number;
      txnExcluded: number;
      balances: number;
      supersededBy: { filename: string; count: number }[];
    }
  >();
  for (const id of batchIds) {
    countsByBatch.set(id, {
      txnNew: 0,
      txnDupe: 0,
      txnExcluded: 0,
      balances: 0,
      supersededBy: [],
    });
  }
  for (const c of counts) {
    const entry = countsByBatch.get(c.batchId)!;
    if (c.rowKind === "balance") {
      if (c.status !== "excluded" && c.status !== "duplicate") entry.balances += c.count;
      continue;
    }
    // Rows another file is providing are not this file's to add
    if (c.supersededByBatchId != null) {
      const name = filenames.get(c.supersededByBatchId) ?? `#${c.supersededByBatchId}`;
      const seen = entry.supersededBy.find((s) => s.filename === name);
      if (seen) seen.count += c.count;
      else entry.supersededBy.push({ filename: name, count: c.count });
      continue;
    }
    if (c.status === "new" || c.status === "possible_duplicate") {
      entry.txnNew += c.count;
    } else if (c.status === "duplicate") {
      entry.txnDupe += c.count;
    } else {
      entry.txnExcluded += c.count;
    }
  }

  // Reconcile as though the pending rows were already in — the whole point of
  // uploading statements alongside transactions.
  const reviewable = batches.filter((b) => b.status === "review").map((b) => b.id);
  const pending = await pendingRowsForBatches(reviewable);
  const touchedAccounts = [
    ...new Set(batches.map((b) => b.accountId).filter((id): id is number => id != null)),
  ];
  const reconciliation = await reconcileAccounts(pending, touchedAccounts);

  return {
    session: {
      id: session.id,
      status: session.status,
      notes: (session.notesJson ? JSON.parse(session.notesJson) : []) as {
        filename: string;
        error: string;
      }[],
    },
    batches: batches.map((b) => {
      const stats = b.statsJson ? JSON.parse(b.statsJson) : {};
      return {
        id: b.id,
        filename: b.filename,
        kind: b.kind,
        sourceType: b.sourceType,
        status: b.status,
        accountId: b.accountId,
        accountLabel: b.accountLabel,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        rowCount: b.rowCount,
        counts: countsByBatch.get(b.id) ?? {
          txnNew: 0,
          txnDupe: 0,
          txnExcluded: 0,
          balances: 0,
          supersededBy: [] as { filename: string; count: number }[],
        },
        priorWarning: (stats.priorWarning ?? null) as string | null,
        accountAssignment: (stats.accountAssignment ?? null) as string | null,
        extractionProblems: (stats.extractionProblems ?? []) as string[],
        rowErrors: (stats.rowErrors ?? []) as { rowIndex: number; problem: string }[],
        overlaps: (stats.overlaps ?? []) as {
          id: number;
          filename: string;
          periodStart: string;
          periodEnd: string;
        }[],
        committed:
          b.status === "committed"
            ? {
                inserted: stats.inserted ?? 0,
                balancesRecorded: stats.balancesRecorded ?? 0,
                skipped: stats.skipped ?? 0,
                autoCategorized: stats.autoCategorized ?? 0,
              }
            : null,
      };
    }),
    accounts,
    reconciliation,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const sessionId = Number(params.sessionId);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "reassign") {
    const batchId = Number(form.get("batchId"));
    const accountId = Number(form.get("accountId"));
    if (!batchId || !accountId) {
      return data({ error: "Pick an account." }, { status: 400 });
    }
    try {
      await reassignBatch(batchId, accountId);
      // Overlap is per account, so moving a file changes who owns what
      await dedupeSessionBatches(sessionId);
    } catch (err) {
      return data(
        { error: err instanceof Error ? err.message : "Could not reassign that file." },
        { status: 400 },
      );
    }
    return { ok: true };
  }

  if (intent === "discard-batch") {
    await discardBatch(Number(form.get("batchId")));
    return { ok: true };
  }

  if (intent === "discard-all") {
    await discardSession(sessionId);
    return redirect("/import");
  }

  if (intent === "commit") {
    const result = await commitSession(sessionId);
    if (result.blocked.length > 0) {
      return data(
        {
          error: `Not committed — ${result.blocked
            .map((b) => `${b.filename} ${b.reason}`)
            .join("; ")}.`,
        },
        { status: 400 },
      );
    }
    // Nothing was added (all duplicates, or a balances-only import) — there is
    // no import to go and look at, so stay on the summary instead.
    // Commit stats travel via query string since they only live in memory here
    // (per-batch statsJson doesn't carry the session-wide transfer-link count).
    if (result.stats.inserted > 0) {
      return redirect(
        `/transactions?${await importedRegisterSearch(
          result.committedBatchIds,
          result.stats,
        )}`,
      );
    }
    return { committed: result.stats };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

const STATUS_STYLES: Record<string, string> = {
  mapping: "bg-class-living text-white",
  review: "bg-primary-600 text-white",
  committed: "bg-positive text-white",
  discarded: "bg-gray-400 text-white",
};

export default function ImportSession({ loaderData, actionData }: Route.ComponentProps) {
  const { session, batches, accounts, reconciliation } = loaderData;
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const committing = navigation.state === "submitting";

  const active = batches.filter((b) => b.status !== "discarded");
  const needsMapping = active.filter((b) => b.status === "mapping");
  const ready = active.filter((b) => b.status === "review");
  const committed = active.filter((b) => b.status === "committed");
  const allCommitted = active.length > 0 && committed.length === active.length;

  const totals = ready.reduce(
    (acc, b) => ({
      txns: acc.txns + b.counts.txnNew,
      balances: acc.balances + b.counts.balances,
    }),
    { txns: 0, balances: 0 },
  );

  const justCommitted =
    actionData && "committed" in actionData ? actionData.committed : null;

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <Link to="/import" className="text-xs font-medium text-primary-600 hover:underline">
          ← Import
        </Link>
        <h1 className="mt-1 text-[16px] font-bold text-primary-950">
          🔍 Review import — {active.length} file{active.length === 1 ? "" : "s"}
        </h1>
        <p className="text-sm text-gray-500">
          {allCommitted
            ? "This import is in the books."
            : `${totals.txns} transactions and ${totals.balances} balance${
                totals.balances === 1 ? "" : "s"
              } ready to commit${
                needsMapping.length > 0
                  ? ` · ${needsMapping.length} file${
                      needsMapping.length === 1 ? " still needs" : "s still need"
                    } column mapping`
                  : ""
              }.`}
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}
      {justCommitted && (
        <p className="groove bg-[#eaffea] px-3 py-1.5 text-[12px] font-bold text-positive">
          ✅ {justCommitted.inserted} transactions added
          {justCommitted.balancesRecorded > 0 &&
            `, ${justCommitted.balancesRecorded} balance${
              justCommitted.balancesRecorded === 1 ? "" : "s"
            } recorded`}
          {justCommitted.autoCategorized > 0 &&
            `, ${justCommitted.autoCategorized} auto-categorized`}
          {justCommitted.skipped > 0 && `, ${justCommitted.skipped} skipped as duplicates`}
          {justCommitted.transfersLinked > 0 &&
            `, ${justCommitted.transfersLinked} transfer pair${
              justCommitted.transfersLinked === 1 ? "" : "s"
            } linked`}
          .
        </p>
      )}
      {session.notes.length > 0 && (
        <div className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] text-negative">
          <p className="font-bold">
            ⛔ {session.notes.length} file{session.notes.length === 1 ? "" : "s"} could not
            be read:
          </p>
          <ul className="mt-1 list-inside list-disc text-[11px]">
            {session.notes.map((n, i) => (
              <li key={i}>
                {n.filename} — {n.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader title="Files in this import" />
        {active.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Every file in this import was discarded" />
          </div>
        ) : (
          <ul className="divide-y divide-primary-100 bg-ledger">
            {active.map((b) => (
              <li key={b.id} className="space-y-1.5 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`px-1.5 text-[10px] font-bold uppercase ${STATUS_STYLES[b.status]}`}
                  >
                    {b.status}
                  </span>
                  <span className="flex-1 text-[12px] font-bold text-gray-900">
                    {b.filename}
                    <span className="ml-2 text-[11px] font-normal text-gray-500">
                      {b.sourceType.toUpperCase()} · {KIND_LABELS[b.kind] ?? b.kind}
                      {b.periodStart && b.periodEnd &&
                        ` · ${formatDateRange(b.periodStart, b.periodEnd)}`}
                    </span>
                  </span>

                  {b.status === "mapping" ? (
                    <Link
                      to={`/import/${b.id}/map`}
                      className="bevel-btn px-2.5 py-[3px] text-[11px] font-bold text-primary-900"
                    >
                      Map columns →
                    </Link>
                  ) : b.status === "review" ? (
                    <Link
                      to={`/import/${b.id}`}
                      className="text-[11px] font-medium text-primary-600 hover:underline"
                    >
                      Review rows →
                    </Link>
                  ) : null}

                  {b.status !== "committed" && (
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="discard-batch" />
                      <input type="hidden" name="batchId" value={b.id} />
                      <Button variant="ghost" size="sm" type="submit">
                        Drop
                      </Button>
                    </fetcher.Form>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-600">
                  {b.status === "committed" && b.committed ? (
                    <span className="text-positive">
                      ✓ {b.committed.inserted} added
                      {b.committed.balancesRecorded > 0 &&
                        `, ${b.committed.balancesRecorded} balance${
                          b.committed.balancesRecorded === 1 ? "" : "s"
                        }`}
                      {b.committed.skipped > 0 && `, ${b.committed.skipped} skipped`}
                    </span>
                  ) : (
                    <>
                      <fetcher.Form method="post" className="flex items-center gap-1.5">
                        <input type="hidden" name="intent" value="reassign" />
                        <input type="hidden" name="batchId" value={b.id} />
                        <span className="text-[11px] font-bold text-gray-800">Account:</span>
                        <select
                          name="accountId"
                          defaultValue={b.accountId ?? ""}
                          onChange={(e) => fetcher.submit(e.currentTarget.form)}
                          className={`${selectClass} py-[1px] text-[11px]`}
                        >
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.institution})
                            </option>
                          ))}
                        </select>
                      </fetcher.Form>
                      {b.status === "review" && (
                        <span>
                          {b.counts.txnNew} to add
                          {b.counts.txnDupe > 0 && ` · ${b.counts.txnDupe} duplicates`}
                          {b.counts.txnExcluded > 0 && ` · ${b.counts.txnExcluded} excluded`}
                          {b.counts.balances > 0 &&
                            ` · ${b.counts.balances} balance${b.counts.balances === 1 ? "" : "s"}`}
                        </span>
                      )}
                    </>
                  )}
                  {b.accountAssignment && b.status !== "committed" && (
                    <span className="italic text-gray-500">{b.accountAssignment}</span>
                  )}
                </div>

                {b.counts.supersededBy.length > 0 && (
                  <p className="groove bg-primary-50 px-2 py-1 text-[11px] text-primary-800">
                    💡 {b.counts.supersededBy.map((s) => s.count).reduce((a, c) => a + c, 0)}{" "}
                    of these rows are already coming from{" "}
                    {b.counts.supersededBy.map((s) => s.filename).join(" and ")} — the same
                    activity in two files. They are counted once, from the more reliable
                    file. Drop that file instead if you would rather this one supplied them.
                  </p>
                )}
                {b.priorWarning && (
                  <p className="groove bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
                    ⚠ {b.priorWarning}
                  </p>
                )}
                {b.overlaps.length > 0 && (
                  <p className="groove bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
                    ⚠ Overlaps {b.overlaps.length} earlier import
                    {b.overlaps.length === 1 ? "" : "s"} for this account:{" "}
                    {b.overlaps
                      .map((o) => `${o.filename} (${formatDateRange(o.periodStart, o.periodEnd)})`)
                      .join(", ")}
                    . Duplicate rows are detected individually — check the counts above.
                  </p>
                )}
                {b.extractionProblems.length > 0 && (
                  <details className="groove bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
                    <summary>
                      ⚠ {b.extractionProblems.length} problem
                      {b.extractionProblems.length === 1 ? "" : "s"} during extraction
                    </summary>
                    <ul className="mt-1 list-inside list-disc">
                      {b.extractionProblems.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {b.rowErrors.length > 0 && (
                  <details className="groove bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
                    <summary>⚠ {b.rowErrors.length} rows failed to parse</summary>
                    <ul className="mt-1 list-inside list-disc">
                      {b.rowErrors.map((e, i) => (
                        <li key={i}>
                          Row {e.rowIndex + 1}: {e.problem}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={
            allCommitted
              ? "⚖️ Reconciliation"
              : "⚖️ Reconciliation — if you commit this import"
          }
        />
        <div className="bg-ledger p-3">
          <ReconcilePanel
            results={reconciliation}
            emptyMessage="No known balances for these accounts yet, so there is nothing to check the transactions against. Close a month against a statement on Monthly Reconcile, or set a balance by hand on the Account Balances page."
          />
        </div>
      </Card>

      {!allCommitted && (
        <div className="flex items-center justify-between pb-6">
          <Form method="post">
            <input type="hidden" name="intent" value="discard-all" />
            <Button variant="danger" type="submit">
              Discard whole import
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="commit" />
            <Button
              type="submit"
              disabled={committing || ready.length === 0 || needsMapping.length > 0}
            >
              {committing
                ? "Committing…"
                : needsMapping.length > 0
                  ? `Map ${needsMapping.length} file${needsMapping.length === 1 ? "" : "s"} first`
                  : `Commit ${totals.txns} transactions · ${totals.balances} balances`}
            </Button>
          </Form>
        </div>
      )}

      {allCommitted && (
        <div className="flex gap-4 pb-6 text-sm">
          <Link to="/transactions" className="font-medium text-primary-600 hover:underline">
            View transactions →
          </Link>
          <Link to="/balances" className="font-medium text-primary-600 hover:underline">
            Account Balances →
          </Link>
          <Link to="/import" className="font-medium text-primary-600 hover:underline">
            Import more
          </Link>
        </div>
      )}
    </div>
  );
}
