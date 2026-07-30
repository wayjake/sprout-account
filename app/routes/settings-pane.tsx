import { Outlet, useLocation, useNavigate } from "react-router";
import { sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { AccountsPane } from "~/components/accounts-pane";
import { PaneWindow } from "~/components/pane-window";
import { PANE_TITLES, paneClosedHref, paneFromSearch } from "~/lib/panes";
import type { Route } from "./+types/settings-pane";

/**
 * Pathless layout wrapping every screen. It renders the screen through
 * `<Outlet />` and, when `?pane=` is set, a modal settings window on top of it
 * — so the screen underneath keeps its state and scroll position.
 *
 * The loader only does work when a pane is actually open, so the cost on a
 * normal navigation is one `URLSearchParams` parse.
 *
 * Pane *writes* live in their own action routes (`routes/settings.accounts.ts`)
 * rather than here: a pathless layout has no URL of its own to post to.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const pane = paneFromSearch(new URL(request.url).search);
  if (pane !== "accounts") return { pane, accounts: null };

  // Counts decide whether an account is safe to delete outright. Grouped
  // queries rather than correlated subqueries: drizzle renders interpolated
  // columns unqualified, which inside a subquery silently resolves against the
  // wrong table.
  const [accounts, txns, snapshots, batches] = await Promise.all([
    db
      .select()
      .from(schema.accounts)
      .orderBy(schema.accounts.sortOrder, schema.accounts.name),
    db
      .select({
        accountId: schema.transactions.accountId,
        count: sql<number>`count(*)`,
      })
      .from(schema.transactions)
      .groupBy(schema.transactions.accountId),
    db
      .select({
        accountId: schema.balanceSnapshots.accountId,
        count: sql<number>`count(*)`,
      })
      .from(schema.balanceSnapshots)
      .groupBy(schema.balanceSnapshots.accountId),
    db
      .select({
        accountId: schema.importBatches.accountId,
        count: sql<number>`count(*)`,
      })
      .from(schema.importBatches)
      .groupBy(schema.importBatches.accountId),
  ]);

  const tally = (rows: { accountId: number | null; count: number }[]) =>
    new Map(rows.filter((r) => r.accountId != null).map((r) => [r.accountId!, r.count]));
  const txnsBy = tally(txns);
  const snapshotsBy = tally(snapshots);
  const batchesBy = tally(batches);

  return {
    pane,
    accounts: accounts.map((account) => ({
      ...account,
      txnCount: txnsBy.get(account.id) ?? 0,
      snapshotCount: snapshotsBy.get(account.id) ?? 0,
      batchCount: batchesBy.get(account.id) ?? 0,
    })),
  };
}

export default function SettingsPaneLayout({ loaderData }: Route.ComponentProps) {
  const { pane, accounts } = loaderData;
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <>
      <Outlet />
      <PaneWindow
        open={pane != null}
        title={pane ? PANE_TITLES[pane] : ""}
        width={pane === "about" ? "26rem" : "44rem"}
        onClose={() => navigate(paneClosedHref(location))}
      >
        {pane === "accounts" && accounts && <AccountsPane accounts={accounts} />}
        {pane === "about" && <AboutPane />}
      </PaneWindow>
    </>
  );
}

function AboutPane() {
  return (
    <div className="flex items-start gap-4 p-5">
      <span className="text-4xl" aria-hidden>
        🌱
      </span>
      <div className="text-[12px]">
        <p className="text-[13px] font-bold text-primary-900">
          Sprout Account — Household Ledger
        </p>
        <p className="mt-1 text-gray-700">
          A local-only household finance manager. Your statements, categories and
          balances live in a SQLite file on this machine — no accounts, no cloud, no
          syncing.
        </p>
        <p className="mt-3 text-gray-700">
          Statement import, categorization and Amazon matching can call an AI model
          when a key is configured; everything else works offline.
        </p>
      </div>
    </div>
  );
}
