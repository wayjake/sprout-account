import { data } from "react-router";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { recordUserChoice } from "~/.server/categorize";
import type { Route } from "./+types/api.transactions-bulk";

/**
 * Bulk edits from the register's selection, posted by the bulk window in
 * `components/bulk-categorize.tsx`.
 *
 * An action-only route, like `settings.accounts.ts`: the register itself is
 * read-only and the selection is client state, so there is no URL to post to.
 * Registered outside the `shell` / `settings-pane` layouts so a submission
 * doesn't drag the pane loader along with it.
 *
 * POST intent=categorize ids=1,2,3 categoryId=7 [remember=on]
 *
 * Deliberately *not* guarded by `guardLiabilityCredit`: that rule exists to stop
 * the memory and AI passes from filing a credit on a debt as income. A choice
 * the user made by hand wins here exactly as it does in the transaction window.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "categorize") {
    return data({ error: "Unknown intent" }, { status: 400 });
  }

  const ids = String(form.get("ids") ?? "")
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    return data({ error: "No transactions selected." }, { status: 400 });
  }

  const categoryId = Number(String(form.get("categoryId") ?? ""));
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return data({ error: "Pick a category first." }, { status: 400 });
  }
  const remember = form.get("remember") != null;

  const t = schema.transactions;
  const [category] = await db
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .limit(1);
  if (!category) {
    return data({ error: "That category no longer exists." }, { status: 400 });
  }

  // Read the rows back rather than trusting the posted ids: the count reported
  // to the user has to be what actually changed, and the merchants are needed
  // for memory anyway.
  const rows = await db
    .select({ id: t.id, merchant: t.merchant })
    .from(t)
    .where(inArray(t.id, ids));
  if (rows.length === 0) {
    return data(
      { error: "Those transactions are no longer in the ledger." },
      { status: 404 },
    );
  }

  // One statement for the whole selection — under Turso every write is a
  // network round trip, so a per-row loop would be one per row.
  await db
    .update(t)
    .set({ categoryId, categorySource: "user" })
    .where(
      inArray(
        t.id,
        rows.map((r) => r.id),
      ),
    );

  // `recordUserChoice` overwrites whatever was in memory for the merchant, so
  // it is the one persistent side effect here that outlives these rows. The
  // window says which merchants it will write and lets the user opt out.
  const merchants = remember
    ? [...new Set(rows.map((r) => r.merchant).filter(Boolean))]
    : [];
  for (const merchant of merchants) {
    await recordUserChoice(merchant, categoryId);
  }

  return {
    ok: true as const,
    updated: rows.length,
    remembered: merchants.length,
    categoryName: category.name,
  };
}
