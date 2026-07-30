import { Form, Link, data, redirect, useFetcher } from "react-router";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import {
  commitBatch,
  discardBatch,
  findOverlappingBatches,
} from "~/.server/import/stage";
import type { StagedBalanceData, StagedTxnData } from "~/.server/import/stage";
import { Amount, Button, Card, CardHeader } from "~/components/ui";
import { formatDate, formatDateRange } from "~/lib/dates";
import type { Route } from "./+types/import-review";

export function meta() {
  return [{ title: "Review Import · Sprout Account — Household Ledger" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, Number(params.batchId)),
    with: { account: true },
  });
  if (!batch) throw data("Import batch not found", { status: 404 });
  if (batch.status === "mapping") throw redirect(`/import/${batch.id}/map`);

  const rows = await db
    .select()
    .from(schema.stagedRows)
    .where(eq(schema.stagedRows.batchId, batch.id))
    .orderBy(asc(schema.stagedRows.rowIndex));

  // A different file covering dates we've already imported to this account.
  const overlaps =
    batch.status === "review" && batch.accountId && batch.periodStart && batch.periodEnd
      ? await findOverlappingBatches({
          accountId: batch.accountId,
          periodStart: batch.periodStart,
          periodEnd: batch.periodEnd,
          excludeBatchId: batch.id,
        })
      : [];

  // Names of the other files in this upload, for rows they have claimed
  const siblings = batch.sessionId
    ? await db
        .select({
          id: schema.importBatches.id,
          filename: schema.importBatches.filename,
        })
        .from(schema.importBatches)
        .where(eq(schema.importBatches.sessionId, batch.sessionId))
    : [];
  const siblingNames = new Map(siblings.map((s) => [s.id, s.filename]));

  const stats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
  return {
    overlaps,
    batch: {
      id: batch.id,
      sessionId: batch.sessionId,
      filename: batch.filename,
      kind: batch.kind,
      status: batch.status,
      accountName: batch.accountLabel ?? batch.account?.name ?? "—",
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
    },
    txnRows: rows
      .filter((r) => r.rowKind === "transaction")
      .map((r) => ({
        id: r.id,
        status: r.status,
        duplicateOfId: r.duplicateOfId,
        supersededBy: r.supersededByBatchId
          ? (siblingNames.get(r.supersededByBatchId) ?? "another file")
          : null,
        data: JSON.parse(r.dataJson) as StagedTxnData,
      })),
    balanceRows: rows
      .filter((r) => r.rowKind === "balance")
      .map((r) => ({
        id: r.id,
        status: r.status,
        data: JSON.parse(r.dataJson) as StagedBalanceData,
      })),
    priorWarning: (stats.priorWarning ?? null) as string | null,
    extractionProblems: (stats.extractionProblems ?? []) as string[],
    rowErrors: (stats.rowErrors ?? []) as { rowIndex: number; problem: string }[],
    commitStats:
      batch.status === "committed"
        ? {
            inserted: stats.inserted ?? 0,
            balancesRecorded: stats.balancesRecorded ?? 0,
            skipped: stats.skipped ?? 0,
            autoCategorized: stats.autoCategorized ?? 0,
            transfersLinked: stats.transfersLinked ?? 0,
          }
        : null,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const batchId = Number(params.batchId);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "toggle-row") {
    const rowId = Number(form.get("rowId"));
    const include = form.get("include") === "true";
    const [row] = await db
      .select()
      .from(schema.stagedRows)
      .where(and(eq(schema.stagedRows.id, rowId), eq(schema.stagedRows.batchId, batchId)))
      .limit(1);
    if (!row) return data({ error: "Row not found" }, { status: 404 });
    // Toggling flips between excluded and new; re-including a detected
    // duplicate is an explicit user override.
    await db
      .update(schema.stagedRows)
      .set({ status: include ? "new" : "excluded" })
      .where(eq(schema.stagedRows.id, rowId));
    return { ok: true };
  }

  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, batchId),
  });

  if (intent === "commit") {
    const stats = await commitBatch(batchId);
    // Part of a multi-file import? Reconciliation lives on the session page.
    if (batch?.sessionId) return redirect(`/import/session/${batch.sessionId}`);
    return { committed: stats };
  }

  if (intent === "discard") {
    await discardBatch(batchId);
    return redirect(batch?.sessionId ? `/import/session/${batch.sessionId}` : "/import");
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

const ROW_BADGES: Record<string, { label: string; cls: string }> = {
  new: { label: "new", cls: "bg-positive/15 text-positive" },
  duplicate: { label: "duplicate", cls: "bg-negative/10 text-negative" },
  possible_duplicate: { label: "possible dup", cls: "bg-class-living/15 text-class-living" },
  excluded: { label: "excluded", cls: "bg-gray-200 text-gray-500" },
};

export default function ImportReview({ loaderData }: Route.ComponentProps) {
  const {
    batch,
    txnRows,
    balanceRows,
    overlaps,
    priorWarning,
    extractionProblems,
    rowErrors,
    commitStats,
  } = loaderData;
  const fetcher = useFetcher();

  const isIncluded = (status: string) =>
    status === "new" || status === "possible_duplicate";
  const includedTxns = txnRows.filter((r) => isIncluded(r.status) && !r.supersededBy);
  const supersededCount = txnRows.filter((r) => r.supersededBy).length;
  const includedBalances = balanceRows.filter((r) => isIncluded(r.status));
  const counts = {
    new: txnRows.filter((r) => r.status === "new").length,
    duplicate: txnRows.filter((r) => r.status === "duplicate").length,
    possible: txnRows.filter((r) => r.status === "possible_duplicate").length,
    excluded: txnRows.filter((r) => r.status === "excluded").length,
  };

  const backTo = batch.sessionId ? `/import/session/${batch.sessionId}` : "/import";

  if (batch.status === "committed") {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-[16px] font-bold text-primary-950">
          🎉 Import committed to the ledger!
        </h1>
        <Card>
          <div className="p-6 text-sm text-gray-700">
            <p className="font-medium text-positive">
              ✓ {batch.filename} → {batch.accountName}
            </p>
            {batch.periodStart && batch.periodEnd && (
              <p className="mt-1 text-xs text-gray-500">
                Covering {formatDateRange(batch.periodStart, batch.periodEnd)}
              </p>
            )}
            {commitStats && (
              <p className="mt-2">
                {commitStats.inserted} transactions added
                {commitStats.balancesRecorded > 0 &&
                  `, ${commitStats.balancesRecorded} balance${
                    commitStats.balancesRecorded === 1 ? "" : "s"
                  } recorded`}
                {commitStats.autoCategorized > 0 &&
                  `, ${commitStats.autoCategorized} auto-categorized from memory`}
                {commitStats.skipped > 0 && `, ${commitStats.skipped} skipped as duplicates`}
                {commitStats.transfersLinked > 0 &&
                  `, ${commitStats.transfersLinked} transfer pair${
                    commitStats.transfersLinked === 1 ? "" : "s"
                  } linked between accounts`}
                .
              </p>
            )}
            <div className="mt-4 flex gap-4">
              <Link to="/transactions" className="font-medium text-primary-600 hover:underline">
                View transactions →
              </Link>
              <Link to="/balances" className="font-medium text-primary-600 hover:underline">
                Account Balances →
              </Link>
              <Link to="/import" className="font-medium text-primary-600 hover:underline">
                Import another
              </Link>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link to={backTo} className="text-xs font-medium text-primary-600 hover:underline">
          ← {batch.sessionId ? "Back to the import" : "Import"}
        </Link>
        <h1 className="mt-1 text-[16px] font-bold text-primary-950">🔍 Review import</h1>
        <p className="text-sm text-gray-500">
          {batch.filename} → {batch.accountName}
          {batch.periodStart && batch.periodEnd &&
            ` · ${formatDateRange(batch.periodStart, batch.periodEnd)}`}{" "}
          · {counts.new} new · {counts.duplicate} duplicates (pre-excluded) ·{" "}
          {counts.possible} possible duplicates · {counts.excluded} excluded
          {balanceRows.length > 0 &&
            ` · ${balanceRows.length} balance${balanceRows.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {supersededCount > 0 && (
        <p className="groove bg-primary-50 px-3 py-1.5 text-[12px] text-primary-800">
          💡 {supersededCount} of these rows are already supplied by another file in this
          upload and are shown greyed out. They will be imported once, from that file.
        </p>
      )}
      {priorWarning && (
        <p className="groove bg-[#fff7dd] px-3 py-1.5 text-[12px] text-class-living">
          ⚠ {priorWarning}
        </p>
      )}
      {overlaps.length > 0 && (
        <p className="groove bg-[#fff7dd] px-3 py-1.5 text-[12px] text-class-living">
          ⚠ This period overlaps {overlaps.length} earlier import
          {overlaps.length === 1 ? "" : "s"} for this account:{" "}
          {overlaps
            .map((o) => `${o.filename} (${formatDateRange(o.periodStart, o.periodEnd)})`)
            .join(", ")}
          . Rows already on file are marked duplicate below.
        </p>
      )}
      {extractionProblems.length > 0 && (
        <details className="groove bg-[#fff7dd] px-3 py-1.5 text-[12px] text-class-living">
          <summary>⚠ {extractionProblems.length} problems during PDF extraction</summary>
          <ul className="mt-1 list-inside list-disc text-xs">
            {extractionProblems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      {rowErrors.length > 0 && (
        <details className="groove bg-[#fff7dd] px-3 py-1.5 text-[12px] text-class-living">
          <summary>⚠ {rowErrors.length} CSV rows failed to parse</summary>
          <ul className="mt-1 list-inside list-disc text-xs">
            {rowErrors.map((e, i) => (
              <li key={i}>
                Row {e.rowIndex + 1}: {e.problem}
              </li>
            ))}
          </ul>
        </details>
      )}

      {balanceRows.length > 0 && (
        <Card>
          <CardHeader title="Balances found in this file" />
          <table className="w-full bg-ledger text-sm">
            <thead>
              <tr className="border-b border-primary-100 bg-primary-50/60 text-left text-xs font-semibold text-primary-800">
                <th className="w-10 px-4 py-2.5">In</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Which</th>
                <th className="px-4 py-2.5 text-right">Balance</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-50">
              {balanceRows.map((r) => {
                const badge = ROW_BADGES[r.status];
                const included = isIncluded(r.status);
                return (
                  <tr key={r.id} className={included ? "" : "opacity-50"}>
                    <td className="px-4 py-1.5">
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="toggle-row" />
                        <input type="hidden" name="rowId" value={r.id} />
                        <input type="hidden" name="include" value={String(!included)} />
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={(e) => fetcher.submit(e.currentTarget.form)}
                          className="h-4 w-4 accent-primary-600"
                        />
                      </fetcher.Form>
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-gray-500">
                      {formatDate(r.data.date)}
                    </td>
                    <td className="px-4 py-1.5 text-xs text-gray-500">
                      {r.data.kind ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-right">
                      <Amount cents={r.data.balanceCents} />
                    </td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                      >
                        {r.status === "possible_duplicate" ? "replaces existing" : badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {txnRows.length > 0 && (
        <Card>
          <CardHeader title="Transactions" />
          <table className="w-full bg-ledger text-sm">
            <thead>
              <tr className="border-b border-primary-100 bg-primary-50/60 text-left text-xs font-semibold text-primary-800">
                <th className="w-10 px-4 py-2.5">In</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-50">
              {txnRows.map((r) => {
                const badge = ROW_BADGES[r.status];
                const included = isIncluded(r.status) && !r.supersededBy;
                return (
                  <tr key={r.id} className={included ? "" : "opacity-50"}>
                    <td className="px-4 py-1.5">
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="toggle-row" />
                        <input type="hidden" name="rowId" value={r.id} />
                        <input type="hidden" name="include" value={String(!included)} />
                        <input
                          type="checkbox"
                          checked={included}
                          disabled={Boolean(r.supersededBy)}
                          onChange={(e) => fetcher.submit(e.currentTarget.form)}
                          className="h-4 w-4 accent-primary-600"
                        />
                      </fetcher.Form>
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-gray-500">
                      {formatDate(r.data.date)}
                    </td>
                    <td className="max-w-96 truncate px-4 py-1.5" title={r.data.description}>
                      {r.data.description}
                    </td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-right">
                      <Amount cents={r.data.amountCents} />
                    </td>
                    <td className="px-4 py-1.5">
                      {r.supersededBy ? (
                        <span
                          className="rounded-full bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-800"
                          title={`Provided by ${r.supersededBy}`}
                        >
                          from {r.supersededBy}
                        </span>
                      ) : (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <div className="flex items-center justify-between pb-6">
        <Form method="post">
          <input type="hidden" name="intent" value="discard" />
          <Button variant="danger" type="submit">
            Discard this file
          </Button>
        </Form>
        {batch.sessionId ? (
          <Link
            to={backTo}
            className="bevel-btn px-4 py-[5px] text-[12px] font-bold text-primary-900"
          >
            Done — back to the import →
          </Link>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="commit" />
            <Button
              type="submit"
              disabled={includedTxns.length + includedBalances.length === 0}
            >
              Commit {includedTxns.length} transactions
              {includedBalances.length > 0 && ` · ${includedBalances.length} balances`}
            </Button>
          </Form>
        )}
      </div>
    </div>
  );
}
