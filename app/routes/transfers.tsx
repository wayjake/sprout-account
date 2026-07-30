import { Link, data, useFetcher } from "react-router";
import {
  autoLinkTransfers,
  findTransferSuggestions,
  linkTransferPair,
  linkedTransfers,
  rejectTransferPair,
  transferVolume,
  unlinkTransfer,
  unmatchedTransferLegs,
  type TransferSuggestion,
} from "~/.server/transfers";
import { Button, Card, CardHeader, EmptyState, MessageBar } from "~/components/ui";
import { formatDate, monthEnd, monthOf, monthStart, todayISO } from "~/lib/dates";
import { formatCentsAbs } from "~/lib/money";
import type { Route } from "./+types/transfers";

export function meta() {
  return [{ title: "Transfers · Sprout Account — Household Ledger" }];
}

export async function loader(_: Route.LoaderArgs) {
  const month = monthOf(todayISO());
  const [suggestions, linked, unmatched, monthMovedCents] = await Promise.all([
    findTransferSuggestions(),
    linkedTransfers(),
    unmatchedTransferLegs(),
    transferVolume(monthStart(month), monthEnd(month)),
  ]);
  return { suggestions, linked, unmatched, monthMovedCents };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "link") {
    const error = await linkTransferPair(
      Number(form.get("outId")),
      Number(form.get("inId")),
      "user",
    );
    if (error) return data({ error }, { status: 400 });
    return { ok: true };
  }

  if (intent === "reject") {
    await rejectTransferPair(Number(form.get("outId")), Number(form.get("inId")));
    return { ok: true };
  }

  if (intent === "unlink") {
    await unlinkTransfer(Number(form.get("id")));
    return { ok: true };
  }

  if (intent === "scan") {
    const linked = await autoLinkTransfers();
    return { scanned: linked };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

function PairRow({
  pair,
  actions,
}: {
  pair: TransferSuggestion;
  actions: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className="w-40 shrink-0">
        <span className="block truncate text-[11px] font-bold text-gray-800">
          {pair.out.accountName} → {pair.in.accountName}
        </span>
        <span className="block font-mono text-[10px] text-gray-500">
          {formatDate(pair.out.date)}
          {pair.dayDiff > 0 && ` → ${formatDate(pair.in.date)}`}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <Link
          to={`/transactions/${pair.out.id}`}
          className="block truncate text-[11px] text-gray-700 hover:text-primary-700 hover:underline"
          title={pair.out.description}
        >
          − {pair.out.description}
        </Link>
        <Link
          to={`/transactions/${pair.in.id}`}
          className="block truncate text-[11px] text-gray-700 hover:text-primary-700 hover:underline"
          title={pair.in.description}
        >
          + {pair.in.description}
        </Link>
      </span>
      <span className="shrink-0 font-mono text-[12px] font-bold tabular-nums text-primary-900">
        {formatCentsAbs(pair.out.amountCents)}
      </span>
      <span className="flex shrink-0 gap-1">{actions}</span>
    </li>
  );
}

export default function Transfers({ loaderData }: Route.ComponentProps) {
  const { suggestions, linked, unmatched, monthMovedCents } = loaderData;
  const fetcher = useFetcher<{ error?: string; scanned?: number }>();
  const busy = fetcher.state !== "idle";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[16px] font-bold text-primary-950">⛴️ Transfers</h1>
          <p className="text-[12px] text-gray-600">
            Money moved between your own accounts is neither income nor spending — linked
            pairs stay out of income and expense reports entirely.
          </p>
        </div>
        <div className="bevel-in bg-ledger px-3 py-1.5 text-[11px]">
          <span className="font-bold text-gray-800">Transfers this month:</span>{" "}
          <span className="font-mono font-bold tabular-nums text-primary-900">
            {formatCentsAbs(monthMovedCents)}
          </span>
        </div>
      </div>

      {fetcher.data?.error && <MessageBar kind="error">{fetcher.data.error}</MessageBar>}
      {fetcher.data?.scanned != null && (
        <MessageBar kind={fetcher.data.scanned > 0 ? "success" : "info"}>
          {fetcher.data.scanned > 0
            ? `Auto-matched ${fetcher.data.scanned} obvious transfer${
                fetcher.data.scanned === 1 ? "" : "s"
              }.`
            : "No obvious transfers left to auto-match."}
        </MessageBar>
      )}

      <Card>
        <CardHeader title={`🧭 Suggested transfer matches (${suggestions.length})`}>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="scan" />
            <Button type="submit" size="sm" variant="secondary" disabled={busy}>
              ⚡ Auto-match obvious transfers
            </Button>
          </fetcher.Form>
        </CardHeader>
        {suggestions.length === 0 ? (
          <div className="bg-ledger">
            <EmptyState
              title="No transfer matches need review"
              detail="Matching amounts moving between two accounts within a few days will show up here."
            />
          </div>
        ) : (
          <ul className="ledger-stripes divide-y divide-primary-50 bg-ledger">
            {suggestions.map((s) => (
              <PairRow
                key={`${s.out.id}-${s.in.id}`}
                pair={s}
                actions={
                  <>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="link" />
                      <input type="hidden" name="outId" value={s.out.id} />
                      <input type="hidden" name="inId" value={s.in.id} />
                      <Button type="submit" size="sm" disabled={busy} title="Link as a transfer pair">
                        ⇄ Link
                      </Button>
                    </fetcher.Form>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="reject" />
                      <input type="hidden" name="outId" value={s.out.id} />
                      <input type="hidden" name="inId" value={s.in.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title="Not a transfer — don't suggest this pair again"
                      >
                        ✕
                      </Button>
                    </fetcher.Form>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </Card>

      {unmatched.length > 0 && (
        <Card>
          <CardHeader title={`🦯 Unmatched transfer legs (${unmatched.length})`} />
          <div className="bg-ledger">
            <p className="groove m-2 bg-[#fff7dd] px-3 py-1.5 text-[11px] text-gray-700">
              These are categorized as transfers but no opposite leg is linked. That's
              fine when the far side isn't imported here (a savings goal tracked by balance
              only, or an account you don't track) — otherwise import the other
              account's statement and they'll pair up.
            </p>
            <ul className="ledger-stripes divide-y divide-primary-50">
              {unmatched.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-24 shrink-0 font-mono text-[10px] text-gray-500">
                    {formatDate(t.date)}
                  </span>
                  <span className="w-36 shrink-0 truncate text-[11px] font-bold text-gray-800">
                    {t.accountName}
                  </span>
                  <Link
                    to={`/transactions/${t.id}`}
                    className="min-w-0 flex-1 truncate text-[11px] text-gray-700 hover:text-primary-700 hover:underline"
                    title={t.description}
                  >
                    {t.description}
                  </Link>
                  <span
                    className={`shrink-0 font-mono text-[11px] tabular-nums ${
                      t.amountCents < 0 ? "text-gray-800" : "text-positive"
                    }`}
                  >
                    {t.amountCents < 0 ? "−" : "+"}
                    {formatCentsAbs(t.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title={`⇄ Linked transfers (latest ${linked.length})`} />
        {linked.length === 0 ? (
          <div className="bg-ledger">
            <EmptyState
              title="No linked transfers yet"
              detail="Link a suggestion above, or let statement import auto-match the obvious ones."
            />
          </div>
        ) : (
          <ul className="ledger-stripes divide-y divide-primary-50 bg-ledger">
            {linked.map((p) => (
              <PairRow
                key={`${p.out.id}-${p.in.id}`}
                pair={p}
                actions={
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="unlink" />
                    <input type="hidden" name="id" value={p.out.id} />
                    <Button type="submit" size="sm" variant="ghost" disabled={busy}>
                      Unlink
                    </Button>
                  </fetcher.Form>
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
