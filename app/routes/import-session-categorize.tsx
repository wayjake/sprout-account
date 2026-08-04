import { Link, data, useFetcher, useRouteLoaderData } from "react-router";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { listImportedTransactions } from "~/.server/queries";
import { recordUserChoice } from "~/.server/categorize";
import { CategoryPicker } from "~/components/category-picker";
import {
  Amount,
  Button,
  Card,
  CardHeader,
  ClassBadge,
  EmptyState,
  MessageBar,
} from "~/components/ui";
import { formatDate } from "~/lib/dates";
import type { loader as shellLoader } from "./shell";
import type { Route } from "./+types/import-session-categorize";

export function meta() {
  return [{ title: "Categorize Imports · Sprout Account — Household Ledger" }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const sessionId = Number(params.sessionId);
  const session = await db.query.importSessions.findFirst({
    where: eq(schema.importSessions.id, sessionId),
  });
  if (!session) throw data("Import not found", { status: 404 });

  // Populated only right after a commit redirect — not persisted, so a
  // revisit or bookmark of this URL just won't show the banner.
  const url = new URL(request.url);
  const added = url.searchParams.get("added");
  const commitStats = added
    ? {
        added: Number(added),
        balances: Number(url.searchParams.get("balances") ?? 0),
        skipped: Number(url.searchParams.get("skipped") ?? 0),
        transfers: Number(url.searchParams.get("transfers") ?? 0),
      }
    : null;

  const committedBatches = await db
    .select({
      id: schema.importBatches.id,
      filename: schema.importBatches.filename,
      accountLabel: schema.importBatches.accountLabel,
      accountName: schema.accounts.name,
    })
    .from(schema.importBatches)
    .leftJoin(schema.accounts, eq(schema.importBatches.accountId, schema.accounts.id))
    .where(
      and(
        eq(schema.importBatches.sessionId, sessionId),
        eq(schema.importBatches.status, "committed"),
      ),
    )
    .orderBy(asc(schema.importBatches.id));

  const batchIds = committedBatches.map((b) => b.id);
  const rows = await listImportedTransactions(batchIds);

  const reviewed = rows.filter((r) => r.categorySource === "user");
  // Suggestions (from merchant memory or AI) float to the top so the quick
  // confirm-or-fix pass happens first; plain uncategorized rows sink down.
  const toReview = rows
    .filter((r) => r.categorySource !== "user")
    .sort((a, b) => Number(a.categoryId == null) - Number(b.categoryId == null));

  return {
    files: committedBatches.map((b) => ({
      id: b.id,
      filename: b.filename,
      accountName: b.accountName ?? b.accountLabel,
    })),
    toReview,
    reviewed,
    commitStats,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "set-category") {
    const id = Number(form.get("id"));
    const categoryId = form.get("categoryId") ? Number(form.get("categoryId")) : null;
    const [txn] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, id))
      .limit(1);
    if (!txn) return data({ error: "Not found" }, { status: 404 });

    await db
      .update(schema.transactions)
      .set({ categoryId, categorySource: categoryId ? "user" : null })
      .where(eq(schema.transactions.id, id));
    if (categoryId) await recordUserChoice(txn.merchant, categoryId);
    return { ok: true };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

const SOURCE_LABELS: Record<string, string> = {
  ai: "🔮 AI",
  memory: "🧠 memory",
  auto: "⚙️ rule",
};

function ConfirmButton({
  transactionId,
  categoryId,
}: {
  transactionId: number;
  categoryId: number;
}) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="set-category" />
      <input type="hidden" name="id" value={transactionId} />
      <input type="hidden" name="categoryId" value={categoryId} />
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={fetcher.state !== "idle"}
        title="Accept this category"
      >
        ✓
      </Button>
    </fetcher.Form>
  );
}

export default function ImportSessionCategorize({ loaderData }: Route.ComponentProps) {
  const { files, toReview, reviewed, commitStats } = loaderData;
  const shell = useRouteLoaderData<typeof shellLoader>("routes/shell");
  const categories = shell?.categories ?? [];

  const renderRows = (rows: typeof toReview, showConfirm: boolean) =>
    rows.map((r) => (
      <tr key={r.id}>
        <td className="whitespace-nowrap px-4 py-1.5 text-gray-500">{formatDate(r.date)}</td>
        <td className="max-w-72 px-4 py-1.5">
          <span className="block truncate font-bold text-gray-900" title={r.description}>
            {r.merchant}
          </span>
          <span className="block truncate text-[10px] text-gray-500">{r.description}</span>
        </td>
        <td className="whitespace-nowrap px-4 py-1.5 text-xs text-gray-500">{r.accountName}</td>
        <td className="px-4 py-1.5">
          <div className="flex items-center gap-1.5">
            <CategoryPicker
              transactionId={r.id}
              categoryId={r.categoryId}
              categories={categories}
            />
            {showConfirm && r.categoryId != null && (
              <ConfirmButton transactionId={r.id} categoryId={r.categoryId} />
            )}
            {r.spendingClass && <ClassBadge spendingClass={r.spendingClass} />}
            {r.categorySource && SOURCE_LABELS[r.categorySource] && (
              <span title={`Suggested from ${r.categorySource}`} className="text-[10px]">
                {SOURCE_LABELS[r.categorySource]}
              </span>
            )}
          </div>
        </td>
        <td className="whitespace-nowrap px-4 py-1.5 text-right">
          <Amount cents={r.amountCents} />
        </td>
      </tr>
    ));

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <Link to="/import" className="text-xs font-medium text-primary-600 hover:underline">
          ← Import
        </Link>
        <h1 className="mt-1 text-[16px] font-bold text-primary-950">🏷️ Categorize imports</h1>
        <p className="text-sm text-gray-500">
          {files.map((f) => `${f.filename} → ${f.accountName ?? "—"}`).join(" · ")} ·{" "}
          {toReview.length} to review · {reviewed.length} reviewed
        </p>
      </div>

      {commitStats && (
        <MessageBar kind="success">
          {commitStats.added} transaction{commitStats.added === 1 ? "" : "s"} added
          {commitStats.balances > 0 &&
            `, ${commitStats.balances} balance${commitStats.balances === 1 ? "" : "s"} recorded`}
          {commitStats.skipped > 0 && `, ${commitStats.skipped} skipped as duplicates`}
          {commitStats.transfers > 0 &&
            `, ${commitStats.transfers} transfer pair${
              commitStats.transfers === 1 ? "" : "s"
            } linked between accounts`}
          .
        </MessageBar>
      )}

      <Card>
        <CardHeader title={`To review (${toReview.length})`} />
        {toReview.length === 0 ? (
          <EmptyState
            title="Nothing left to review"
            detail="Every imported transaction has a confirmed category."
          />
        ) : (
          <table className="w-full bg-ledger text-sm">
            <thead>
              <tr className="border-b border-primary-100 bg-primary-50/60 text-left text-xs font-semibold text-primary-800">
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5">Account</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-50">{renderRows(toReview, true)}</tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardHeader title={`Reviewed (${reviewed.length})`} />
        {reviewed.length === 0 ? (
          <EmptyState title="Nothing reviewed yet" detail="Confirm or set a category above." />
        ) : (
          <table className="w-full bg-ledger text-sm">
            <thead>
              <tr className="border-b border-primary-100 bg-primary-50/60 text-left text-xs font-semibold text-primary-800">
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5">Account</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-50">{renderRows(reviewed, false)}</tbody>
          </table>
        )}
      </Card>

      <div className="flex gap-4 pb-6 text-sm">
        <Link to="/transactions" className="font-medium text-primary-600 hover:underline">
          View all transactions →
        </Link>
        <Link to="/import" className="font-medium text-primary-600 hover:underline">
          Import more
        </Link>
      </div>
    </div>
  );
}
