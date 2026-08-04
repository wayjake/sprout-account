import { Form, Link, data, redirect, useFetcher, useNavigation } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { reconcileAccounts } from "~/.server/balances";
import { reassignBatch } from "~/.server/import/intake";
import {
  STATEMENT_MATCH_WINDOW_DAYS,
  commitSession,
  dedupeSessionBatches,
  discardBatch,
  discardSession,
  pendingRowsForBatches,
} from "~/.server/import/stage";
import { statementCloses, type StatementClose } from "~/.server/reconcile";
import { ReconcilePanel } from "~/components/reconciliation";
import { Amount, Button, Card, CardHeader, EmptyState, selectClass } from "~/components/ui";
import { formatDate, formatDateRange } from "~/lib/dates";
import { formatCents } from "~/lib/money";
import type { Route } from "./+types/reconcile-session";

export function meta() {
  return [{ title: "Close the Month · Sprout Account — Household Ledger" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const sessionId = Number(params.sessionId);
  const session = await db.query.importSessions.findFirst({
    where: eq(schema.importSessions.id, sessionId),
  });
  if (!session) throw data("Close not found", { status: 404 });
  // A CSV upload landing here would be reviewed with the wrong screen entirely.
  if (session.purpose !== "reconcile") {
    throw redirect(`/import/session/${sessionId}`);
  }

  const [closes, accounts] = await Promise.all([
    statementCloses(sessionId),
    db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.isActive, true))
      .orderBy(schema.accounts.sortOrder, schema.accounts.name),
  ]);

  // Reconcile as though the close were already committed — the balances it
  // would record and the gap rows it would add, folded into the maths.
  const reviewable = closes.filter((c) => c.status === "review").map((c) => c.batchId);
  const pending = await pendingRowsForBatches(reviewable);
  const touchedAccounts = [
    ...new Set(closes.map((c) => c.accountId).filter((id): id is number => id != null)),
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
    closes,
    accounts,
    reconciliation,
    matchWindowDays: STATEMENT_MATCH_WINDOW_DAYS,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const sessionId = Number(params.sessionId);
  const form = await request.formData();
  const intent = form.get("intent");

  /** Staged-row ids that genuinely belong to this close. */
  async function ownedRowIds(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: schema.stagedRows.id })
      .from(schema.stagedRows)
      .innerJoin(
        schema.importBatches,
        eq(schema.stagedRows.batchId, schema.importBatches.id),
      )
      .where(
        and(
          inArray(schema.stagedRows.id, ids),
          eq(schema.importBatches.sessionId, sessionId),
        ),
      );
    return rows.map((r) => r.id);
  }

  if (intent === "toggle-row" || intent === "toggle-many") {
    const include = form.get("include") === "true";
    const ids = form
      .getAll("rowId")
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
    const owned = await ownedRowIds(ids);
    if (owned.length === 0) return data({ error: "Row not found." }, { status: 404 });
    // Re-including a line the books already had is an explicit override — the
    // match is kept on the row so the screen still says where it came from.
    await db
      .update(schema.stagedRows)
      .set({ status: include ? "new" : "excluded" })
      .where(inArray(schema.stagedRows.id, owned));
    return { ok: true };
  }

  if (intent === "reassign") {
    const batchId = Number(form.get("batchId"));
    const accountId = Number(form.get("accountId"));
    if (!batchId || !accountId) return data({ error: "Pick an account." }, { status: 400 });
    try {
      await reassignBatch(batchId, accountId);
      await dedupeSessionBatches(sessionId);
    } catch (err) {
      return data(
        { error: err instanceof Error ? err.message : "Could not reassign that statement." },
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
    return redirect("/reconcile");
  }

  if (intent === "commit") {
    const result = await commitSession(sessionId);
    if (result.blocked.length > 0) {
      return data(
        {
          error: `Not closed — ${result.blocked
            .map((b) => `${b.filename} ${b.reason}`)
            .join("; ")}.`,
        },
        { status: 400 },
      );
    }
    // Rows added to fill a gap arrive uncategorized, so hand them straight to
    // the confirm-or-fix pass. A close that only recorded balances has nothing
    // to categorize and stays here.
    if (result.stats.inserted > 0) {
      const s = result.stats;
      const qs = new URLSearchParams({
        added: String(s.inserted),
        balances: String(s.balancesRecorded),
        skipped: String(s.skipped),
        transfers: String(s.transfersLinked),
      });
      return redirect(`/import/session/${sessionId}/categorize?${qs}`);
    }
    return { committed: result.stats };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

const STATUS_STYLES: Record<string, string> = {
  review: "bg-primary-600 text-white",
  committed: "bg-positive text-white",
  discarded: "bg-gray-400 text-white",
};

function BalancesTable({ close }: { close: StatementClose }) {
  const fetcher = useFetcher();
  if (close.balances.length === 0) {
    return (
      <p className="groove bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
        ⚠ No opening or closing balance was found on this statement, so it cannot anchor
        the account. The lines below can still be checked against the register.
      </p>
    );
  }
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="border-b border-primary-100 text-left text-[10px] font-bold uppercase text-primary-800">
          <th className="w-8 px-2 py-1">Rec</th>
          <th className="px-2 py-1">Date</th>
          <th className="px-2 py-1">Which</th>
          <th className="px-2 py-1 text-right">Balance</th>
          <th className="px-2 py-1"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-primary-50">
        {close.balances.map((b) => (
          <tr key={b.id} className={b.included ? "" : "opacity-50"}>
            <td className="px-2 py-1">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="toggle-row" />
                <input type="hidden" name="rowId" value={b.id} />
                <input type="hidden" name="include" value={String(!b.included)} />
                <input
                  type="checkbox"
                  checked={b.included}
                  disabled={close.status !== "review"}
                  onChange={(e) => fetcher.submit(e.currentTarget.form)}
                  className="h-3.5 w-3.5 accent-primary-600"
                />
              </fetcher.Form>
            </td>
            <td className="whitespace-nowrap px-2 py-1 text-gray-600">
              {formatDate(b.date)}
            </td>
            <td className="px-2 py-1 text-gray-500">{b.kind ?? "—"}</td>
            <td className="whitespace-nowrap px-2 py-1 text-right">
              <Amount cents={b.balanceCents} />
            </td>
            <td className="px-2 py-1 text-[10px] text-gray-500">
              {b.replaces != null && b.replaces !== b.balanceCents
                ? `replaces ${formatCents(b.replaces)} on file`
                : b.replaces != null
                  ? "already on file"
                  : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MissingRows({
  close,
  matchWindowDays,
}: {
  close: StatementClose;
  matchWindowDays: number;
}) {
  const fetcher = useFetcher();
  const missing = close.rows.filter((r) => r.matchedDate == null);
  const conflicts = close.rows.filter((r) => r.signConflict);
  const matched = close.rows.filter((r) => r.matchedDate != null && !r.signConflict);
  const readOnly = close.status !== "review";

  if (close.rows.length === 0) {
    return (
      <p className="text-[11px] italic text-gray-500">
        No transaction lines on this statement — it anchors the balance only.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-gray-700">
        <span className="font-bold text-positive">{close.matchedCount}</span> of{" "}
        {close.rows.length} lines already in the register
        {missing.length > 0 && (
          <>
            {" "}· <span className="font-bold text-negative">{missing.length}</span> missing
          </>
        )}
        {conflicts.length > 0 && (
          <>
            {" "}·{" "}
            <span className="font-bold text-class-living">{conflicts.length}</span> pointing
            the other way
          </>
        )}
      </p>

      {conflicts.length > 0 && (
        <div className="groove bg-[#fff7dd]">
          <p className="border-b border-primary-100 px-2 py-1 text-[10px] font-bold uppercase text-class-living">
            ⚠ In your books with the opposite sign — not added
          </p>
          <table className="w-full text-[11px]">
            <tbody className="divide-y divide-primary-50">
              {conflicts.map((r) => (
                <tr key={r.id}>
                  <td className="w-24 whitespace-nowrap px-2 py-1 text-gray-600">
                    {formatDate(r.date)}
                  </td>
                  <td className="max-w-72 truncate px-2 py-1" title={r.description}>
                    {r.description}
                  </td>
                  <td className="w-56 whitespace-nowrap px-2 py-1 text-right text-[10px] text-gray-700">
                    statement <Amount cents={r.amountCents} /> · books{" "}
                    <Amount cents={r.matchedAmountCents ?? 0} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-2 py-1 text-[10px] text-gray-700">
            Adding these would double-count them and throw the period off by twice the
            amount, so the close leaves them alone. Usually the statement was read
            backwards; if your register is the wrong one, fix the sign on the transaction
            itself.
          </p>
        </div>
      )}

      {missing.length > 0 && (
        <div className="groove bg-[#fffdf5]">
          <div className="flex items-center justify-between border-b border-primary-100 px-2 py-1">
            <span className="text-[10px] font-bold uppercase text-primary-800">
              Not in your books — tick to add
            </span>
            {!readOnly && (
              <fetcher.Form method="post" className="flex gap-1">
                <input type="hidden" name="intent" value="toggle-many" />
                {missing.map((r) => (
                  <input key={r.id} type="hidden" name="rowId" value={r.id} />
                ))}
                <button
                  type="submit"
                  name="include"
                  value="true"
                  className="bevel-btn px-1.5 py-[1px] text-[10px] font-bold text-primary-900"
                >
                  Add all
                </button>
                <button
                  type="submit"
                  name="include"
                  value="false"
                  className="bevel-btn px-1.5 py-[1px] text-[10px] font-bold text-gray-700"
                >
                  Skip all
                </button>
              </fetcher.Form>
            )}
          </div>
          <table className="w-full text-[11px]">
            <tbody className="divide-y divide-primary-50">
              {missing.map((r) => (
                <tr key={r.id} className={r.included ? "" : "opacity-50"}>
                  <td className="w-8 px-2 py-1">
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="toggle-row" />
                      <input type="hidden" name="rowId" value={r.id} />
                      <input type="hidden" name="include" value={String(!r.included)} />
                      <input
                        type="checkbox"
                        checked={r.included}
                        disabled={readOnly}
                        onChange={(e) => fetcher.submit(e.currentTarget.form)}
                        className="h-3.5 w-3.5 accent-primary-600"
                      />
                    </fetcher.Form>
                  </td>
                  <td className="w-24 whitespace-nowrap px-2 py-1 text-gray-600">
                    {formatDate(r.date)}
                  </td>
                  <td className="max-w-80 truncate px-2 py-1" title={r.description}>
                    {r.description}
                  </td>
                  <td className="w-28 whitespace-nowrap px-2 py-1 text-right">
                    <Amount cents={r.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {matched.length > 0 && (
        <details className="groove bg-primary-50/50 px-2 py-1 text-[11px] text-primary-900">
          <summary className="cursor-pointer">
            ✓ {matched.length} line{matched.length === 1 ? "" : "s"} found in the register
          </summary>
          <p className="mt-1 text-[10px] text-gray-600">
            Matched on amount and a date within {matchWindowDays} days — a statement prints
            the posting date, an export often the transaction date.
          </p>
          <table className="mt-1 w-full">
            <tbody className="divide-y divide-primary-100/60">
              {matched.map((r) => (
                <tr key={r.id} className={r.included ? "bg-[#fff7dd]" : ""}>
                  <td className="w-24 whitespace-nowrap px-2 py-1 text-gray-600">
                    {formatDate(r.date)}
                  </td>
                  <td className="max-w-72 truncate px-2 py-1" title={r.description}>
                    {r.description}
                  </td>
                  <td className="w-28 whitespace-nowrap px-2 py-1 text-right">
                    <Amount cents={r.amountCents} />
                  </td>
                  <td className="px-2 py-1 text-[10px] text-gray-500">
                    {r.included ? (
                      <span className="font-bold text-class-living">
                        forced in — will be added again
                      </span>
                    ) : (
                      <>
                        matched “{r.matchedDescription}”
                        {r.matchedDate !== r.date && ` on ${formatDate(r.matchedDate!)}`}
                      </>
                    )}
                  </td>
                  {!readOnly && (
                    <td className="w-16 px-2 py-1 text-right">
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="toggle-row" />
                        <input type="hidden" name="rowId" value={r.id} />
                        <input
                          type="hidden"
                          name="include"
                          value={String(!r.included)}
                        />
                        <button
                          type="submit"
                          className="text-[10px] font-medium text-primary-600 hover:underline"
                        >
                          {r.included ? "undo" : "add anyway"}
                        </button>
                      </fetcher.Form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

export default function ReconcileSession({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { session, closes, accounts, reconciliation, matchWindowDays } = loaderData;
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const committing = navigation.state === "submitting";

  const ready = closes.filter((c) => c.status === "review");
  const committed = closes.filter((c) => c.status === "committed");
  const allCommitted = closes.length > 0 && committed.length === closes.length;

  const totals = ready.reduce(
    (acc, c) => ({
      adding: acc.adding + c.rows.filter((r) => r.included).length,
      balances: acc.balances + c.balances.filter((b) => b.included).length,
      missingCents: acc.missingCents + c.missingTotalCents,
    }),
    { adding: 0, balances: 0, missingCents: 0 },
  );

  const justCommitted =
    actionData && "committed" in actionData ? actionData.committed : null;

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <Link to="/reconcile" className="text-xs font-medium text-primary-600 hover:underline">
          ← Monthly Reconcile
        </Link>
        <h1 className="mt-1 text-[16px] font-bold text-primary-950">
          ⚖️ Close the month — {closes.length} statement{closes.length === 1 ? "" : "s"}
        </h1>
        <p className="text-sm text-gray-500">
          {allCommitted
            ? "This close is done — the balances are anchored and the gaps are filled."
            : `${totals.balances} balance${
                totals.balances === 1 ? "" : "s"
              } to record · ${totals.adding} missing line${
                totals.adding === 1 ? "" : "s"
              } to add${
                totals.missingCents !== 0
                  ? ` (${formatCents(totals.missingCents)})`
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
          ✅ Month closed — {justCommitted.balancesRecorded} balance
          {justCommitted.balancesRecorded === 1 ? "" : "s"} recorded
          {justCommitted.inserted > 0 && `, ${justCommitted.inserted} missing rows added`}.
        </p>
      )}
      {session.notes.length > 0 && (
        <div className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] text-negative">
          <p className="font-bold">
            ⛔ {session.notes.length} statement{session.notes.length === 1 ? "" : "s"} could
            not be read:
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

      {closes.length === 0 ? (
        <Card>
          <div className="p-4">
            <EmptyState title="Every statement in this close was dropped" />
          </div>
        </Card>
      ) : (
        closes.map((c) => (
          <Card key={c.batchId}>
            <CardHeader title={`📄 ${c.filename}`} />
            <div className="space-y-2 bg-ledger p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`px-1.5 text-[10px] font-bold uppercase ${STATUS_STYLES[c.status]}`}
                >
                  {c.status === "review" ? "to close" : c.status}
                </span>
                {c.status === "review" ? (
                  <fetcher.Form method="post" className="flex items-center gap-1.5">
                    <input type="hidden" name="intent" value="reassign" />
                    <input type="hidden" name="batchId" value={c.batchId} />
                    <span className="text-[11px] font-bold text-gray-800">Account:</span>
                    <select
                      name="accountId"
                      defaultValue={c.accountId ?? ""}
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
                ) : (
                  <span className="text-[11px] font-bold text-gray-800">
                    {c.accountLabel}
                  </span>
                )}
                {c.periodStart && c.periodEnd && (
                  <span className="text-[11px] text-gray-500">
                    {formatDateRange(c.periodStart, c.periodEnd)}
                  </span>
                )}
                <span className="flex-1" />
                {c.status === "review" && (
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="discard-batch" />
                    <input type="hidden" name="batchId" value={c.batchId} />
                    <Button variant="ghost" size="sm" type="submit">
                      Drop
                    </Button>
                  </fetcher.Form>
                )}
              </div>

              {c.accountAssignment && c.status === "review" && (
                <p className="text-[11px] italic text-gray-500">{c.accountAssignment}</p>
              )}
              {c.priorWarning && (
                <p className="groove bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
                  ⚠ {c.priorWarning}
                </p>
              )}
              {c.extractionProblems.length > 0 && (
                <details className="groove bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
                  <summary>
                    ⚠ {c.extractionProblems.length} problem
                    {c.extractionProblems.length === 1 ? "" : "s"} during extraction
                  </summary>
                  <ul className="mt-1 list-inside list-disc">
                    {c.extractionProblems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </details>
              )}

              {c.committed ? (
                <p className="text-[11px] text-positive">
                  ✓ {c.committed.balancesRecorded} balance
                  {c.committed.balancesRecorded === 1 ? "" : "s"} recorded
                  {c.committed.inserted > 0 &&
                    `, ${c.committed.inserted} missing row${
                      c.committed.inserted === 1 ? "" : "s"
                    } added`}
                  {c.committed.autoCategorized > 0 &&
                    `, ${c.committed.autoCategorized} auto-categorized`}
                </p>
              ) : (
                <>
                  <BalancesTable close={c} />
                  <MissingRows close={c} matchWindowDays={matchWindowDays} />
                </>
              )}
            </div>
          </Card>
        ))
      )}

      <Card>
        <CardHeader
          title={allCommitted ? "⚖️ Reconciliation" : "⚖️ Reconciliation — once you close"}
        />
        <div className="bg-ledger p-3">
          <ReconcilePanel
            results={reconciliation}
            emptyMessage="Nothing to check yet — no balances came off these statements."
          />
        </div>
      </Card>

      {!allCommitted && closes.length > 0 && (
        <div className="flex items-center justify-between pb-6">
          <Form method="post">
            <input type="hidden" name="intent" value="discard-all" />
            <Button variant="danger" type="submit">
              Abandon this close
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="commit" />
            <Button type="submit" disabled={committing || ready.length === 0}>
              {committing
                ? "Closing…"
                : `Close the month — ${totals.balances} balances · ${totals.adding} rows`}
            </Button>
          </Form>
        </div>
      )}

      {allCommitted && (
        <div className="flex gap-4 pb-6 text-sm">
          <Link to="/balances" className="font-medium text-primary-600 hover:underline">
            Account Balances →
          </Link>
          <Link to="/transactions" className="font-medium text-primary-600 hover:underline">
            View transactions →
          </Link>
          <Link to="/reconcile" className="font-medium text-primary-600 hover:underline">
            Close another month
          </Link>
        </div>
      )}
    </div>
  );
}
