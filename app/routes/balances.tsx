import { Fragment, useState } from "react";
import { Form, Link, data, useFetcher, useLocation } from "react-router";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import {
  accountBalances,
  deleteBalance,
  isLiability,
  reconcileAccounts,
  setManualBalance,
} from "~/.server/balances";
import { ReconcilePanel } from "~/components/reconciliation";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  inputClass,
  selectClass,
} from "~/components/ui";
import { formatDate, isValidISODate, todayISO } from "~/lib/dates";
import { paneHref } from "~/lib/panes";
import { centsToInput, formatCents, parseCentsInput } from "~/lib/money";
import type { Route } from "./+types/balances";

export function meta() {
  return [{ title: "Account Balances · Sprout Account — Household Ledger" }];
}

export async function loader(_: Route.LoaderArgs) {
  const [balances, reconciliation] = await Promise.all([
    accountBalances(),
    reconcileAccounts(),
  ]);

  const snapshots = await db
    .select({
      id: schema.balanceSnapshots.id,
      accountId: schema.balanceSnapshots.accountId,
      date: schema.balanceSnapshots.date,
      balanceCents: schema.balanceSnapshots.balanceCents,
      source: schema.balanceSnapshots.source,
      note: schema.balanceSnapshots.note,
    })
    .from(schema.balanceSnapshots)
    .orderBy(desc(schema.balanceSnapshots.date));

  const byAccount = new Map<number, typeof snapshots>();
  for (const s of snapshots) {
    if (!byAccount.has(s.accountId)) byAccount.set(s.accountId, []);
    byAccount.get(s.accountId)!.push(s);
  }

  const active = balances.filter((b) => b.account.isActive);
  const netWorthCents = active.reduce(
    (sum, b) => sum + (b.unanchored ? 0 : (b.currentCents ?? 0)),
    0,
  );
  const unanchoredCount = active.filter((b) => b.unanchored).length;

  return {
    balances: active.map((b) => ({
      accountId: b.account.id,
      name: b.account.name,
      institution: b.account.institution,
      accountType: b.account.accountType,
      kind: b.account.kind,
      isLiability: isLiability(b.account.accountType),
      anchor: b.anchor,
      activitySinceAnchorCents: b.activitySinceAnchorCents,
      activitySinceAnchorCount: b.activitySinceAnchorCount,
      currentCents: b.currentCents,
      asOfDate: b.asOfDate,
      unanchored: b.unanchored,
      snapshots: (byAccount.get(b.account.id) ?? []).slice(0, 24),
    })),
    netWorthCents,
    unanchoredCount,
    reconciliation,
    today: todayISO(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "set-balance") {
    const accountId = Number(form.get("accountId"));
    const date = String(form.get("date") ?? "").trim();
    const rawAmount = String(form.get("amount") ?? "").trim();
    const note = String(form.get("note") ?? "").trim() || null;

    if (!accountId) return data({ error: "Pick an account." }, { status: 400 });
    if (!isValidISODate(date)) {
      return data({ error: "Enter a real date (YYYY-MM-DD)." }, { status: 400 });
    }
    if (date > todayISO()) {
      return data({ error: "That date is in the future." }, { status: 400 });
    }
    const balanceCents = parseCentsInput(rawAmount);
    if (balanceCents == null) {
      return data({ error: `Could not read "${rawAmount}" as an amount.` }, { status: 400 });
    }
    const account = await db.query.accounts.findFirst({
      where: eq(schema.accounts.id, accountId),
    });
    if (!account) return data({ error: "Account not found." }, { status: 404 });

    await setManualBalance({ accountId, date, balanceCents, note });
    return {
      ok: `Balance for ${account.name} on ${formatDate(date)} set to ${formatCents(balanceCents)}.`,
    };
  }

  if (intent === "delete-balance") {
    await deleteBalance(Number(form.get("id")));
    return { ok: "Balance removed." };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

function BalanceFigure({
  cents,
  unanchored,
}: {
  cents: number | null;
  unanchored: boolean;
}) {
  if (cents == null) {
    return <span className="text-[12px] italic text-gray-400">unknown</span>;
  }
  return (
    <span
      className={`font-mono tabular-nums text-[13px] font-bold ${
        unanchored ? "text-gray-500" : cents < 0 ? "text-negative" : "text-primary-900"
      }`}
      title={unanchored ? "No known balance — this is the sum of recorded activity" : undefined}
    >
      {formatCents(cents)}
      {unanchored && <span className="ml-1 text-[10px] font-normal">(change only)</span>}
    </span>
  );
}

export default function Balances({ loaderData, actionData }: Route.ComponentProps) {
  const { balances, netWorthCents, unanchoredCount, reconciliation, today } = loaderData;
  const fetcher = useFetcher();
  const location = useLocation();
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-[16px] font-bold text-primary-950">🏦 Account Balances</h1>
        <p className="text-[12px] text-gray-600">
          What every account actually holds. A balance comes off a statement or is set by
          hand, and everything recorded since is added to it.
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}
      {actionData && "ok" in actionData && (
        <p className="groove bg-[#eaffea] px-3 py-1.5 text-[12px] font-bold text-positive">
          ✅ {actionData.ok}
        </p>
      )}

      <Card>
        <CardHeader title="💰 Net worth" />
        <div className="flex items-center justify-between bg-ledger p-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-700">
              Net worth
            </p>
            <p className="text-[11px] text-gray-500">
              Every anchored account added together
              {unanchoredCount > 0 &&
                ` · ${unanchoredCount} account${
                  unanchoredCount === 1 ? "" : "s"
                } left out until a balance is known`}
            </p>
          </div>
          <div className="bevel-in bg-[#101810] px-3 py-2 text-right">
            <span
              className="font-mono text-[20px] font-bold tabular-nums"
              style={{
                color: netWorthCents < 0 ? "#ff6a5c" : "#5cff8a",
                textShadow: `0 0 6px ${netWorthCents < 0 ? "#ff6a5c" : "#5cff8a"}55`,
              }}
            >
              {formatCents(netWorthCents)}
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Accounts" />
        {balances.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No accounts yet"
              detail="Add an account first."
            >
              <Link
                to={paneHref(location, "accounts")}
                className="bevel-btn px-3 py-1 text-[11px] font-bold"
              >
                ⚙️ Go to Accounts
              </Link>
            </EmptyState>
          </div>
        ) : (
          <table className="w-full bg-ledger text-[12px]">
            <thead>
              <tr className="border-b border-primary-100 bg-primary-50/60 text-left text-[10px] font-bold uppercase text-primary-800">
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2 text-right">Balance now</th>
                <th className="px-3 py-2">As of</th>
                <th className="px-3 py-2">Anchored on</th>
                <th className="px-3 py-2 text-right">Since then</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-50">
              {balances.map((b) => (
                <Fragment key={b.accountId}>
                  <tr>
                    <td className="px-3 py-2">
                      <span className="font-bold text-primary-900">{b.name}</span>
                      <span className="ml-1.5 text-[11px] text-gray-500">
                        {b.institution}
                        {b.isLiability && " · card"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <BalanceFigure cents={b.currentCents} unanchored={b.unanchored} />
                    </td>
                    <td className="px-3 py-2 text-[11px] text-gray-500">
                      {b.asOfDate ? formatDate(b.asOfDate) : "—"}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-gray-500">
                      {b.anchor ? (
                        <>
                          {formatDate(b.anchor.date)} ·{" "}
                          <span className="font-mono">{formatCents(b.anchor.balanceCents)}</span>
                          <span className="ml-1 opacity-70">({b.anchor.source})</span>
                        </>
                      ) : (
                        <span className="italic text-class-living">none yet</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px] text-gray-600">
                      {b.anchor && b.activitySinceAnchorCount > 0
                        ? `${b.activitySinceAnchorCount} · ${formatCents(b.activitySinceAnchorCents)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() =>
                          setExpanded(expanded === b.accountId ? null : b.accountId)
                        }
                      >
                        {expanded === b.accountId ? "Hide" : "History"}
                      </Button>
                    </td>
                  </tr>
                  {expanded === b.accountId && (
                    <tr>
                      <td colSpan={6} className="bg-primary-50/40 px-3 py-2">
                        {b.snapshots.length === 0 ? (
                          <p className="text-[11px] italic text-gray-500">
                            No balances recorded for this account yet.
                          </p>
                        ) : (
                          <ul className="space-y-1">
                            {b.snapshots.map((s) => (
                              <li
                                key={s.id}
                                className="flex items-center gap-3 text-[11px]"
                              >
                                <span className="w-24 text-gray-600">
                                  {formatDate(s.date)}
                                </span>
                                <span className="w-28 text-right font-mono tabular-nums">
                                  {formatCents(s.balanceCents)}
                                </span>
                                <span className="w-16 text-gray-500">{s.source}</span>
                                <span className="flex-1 truncate text-gray-500">
                                  {s.note}
                                </span>
                                <fetcher.Form method="post">
                                  <input type="hidden" name="intent" value="delete-balance" />
                                  <input type="hidden" name="id" value={s.id} />
                                  <Button variant="ghost" size="sm" type="submit">
                                    Remove
                                  </Button>
                                </fetcher.Form>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardHeader title="Set a balance by hand" />
        <div className="bg-ledger p-4">
          <Form method="post" className="grid grid-cols-4 gap-3">
            <input type="hidden" name="intent" value="set-balance" />
            <Field label="Account">
              <select name="accountId" className={`${selectClass} w-full`} required>
                {balances.map((b) => (
                  <option key={b.accountId} value={b.accountId}>
                    {b.name} ({b.institution})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="As of date">
              <input
                type="date"
                name="date"
                defaultValue={today}
                max={today}
                className={inputClass}
                required
              />
            </Field>
            <Field label="Balance">
              <input
                name="amount"
                placeholder={centsToInput(123456)}
                className={inputClass}
                required
              />
            </Field>
            <Field label="Note (optional)">
              <input name="note" placeholder="checked on the app" className={inputClass} />
            </Field>
            <div className="col-span-4 flex items-center justify-between">
              <p className="text-[11px] text-gray-500">
                Enter what you owe on a credit card as a negative number (−1,234.56). Setting
                a balance for a date that already has one replaces it.
              </p>
              <Button type="submit">Set balance</Button>
            </div>
          </Form>
        </div>
      </Card>

      <Card>
        <CardHeader title="⚖️ Does it all add up?" />
        <div className="bg-ledger p-3">
          <ReconcilePanel
            results={reconciliation}
            emptyMessage="No known balances yet — set one above, or import a statement that carries its closing balance, and the ledger will start checking itself."
          />
        </div>
      </Card>
    </div>
  );
}
