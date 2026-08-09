import { data } from "react-router";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { isAccountType, resolveAccountKind } from "~/lib/accounts";
import type { AccountKind, AccountType } from "~/db/schema";
import type { PaneActionResult } from "~/lib/panes";
import type { Route } from "./+types/settings.accounts";

/**
 * Writes for the Accounts pane. An action-only route because the pane itself
 * lives in a pathless layout (`routes/settings-pane.tsx`) that has no URL to
 * post to; the pane's fetchers target this path directly, and React Router
 * revalidates the layout and shell loaders afterwards.
 */

function fail(message: string) {
  return data<PaneActionResult>({ error: message }, { status: 400 });
}

interface AccountFields {
  name: string;
  institution: string;
  accountType: AccountType;
  kind: AccountKind;
  lastFour: string | null;
}

/** Name, institution, type, tracking mode and last four — shared by create and update. */
function readFields(
  form: FormData,
): { ok: true; fields: AccountFields } | { ok: false; error: string } {
  const name = String(form.get("name") ?? "").trim();
  const institution = String(form.get("institution") ?? "").trim();
  const accountType = form.get("accountType");
  const lastFour = String(form.get("lastFour") ?? "").trim() || null;

  if (!name) return { ok: false, error: "An account name is required." };
  if (!institution) return { ok: false, error: "An institution is required." };
  if (!isAccountType(accountType)) return { ok: false, error: "Pick an account type." };
  if (lastFour && !/^\d{4}$/.test(lastFour)) {
    return { ok: false, error: "Last four digits must be exactly four numbers." };
  }
  // Only loan types offer the choice; everything else is pinned by its type.
  const kind = resolveAccountKind(accountType, form.get("kind"));
  return { ok: true, fields: { name, institution, accountType, kind, lastFour } };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "create") {
    const parsed = readFields(form);
    if (!parsed.ok) return fail(parsed.error);
    const [{ max }] = await db
      .select({ max: sql<number | null>`max(${schema.accounts.sortOrder})` })
      .from(schema.accounts);
    await db.insert(schema.accounts).values({
      ...parsed.fields,
      sortOrder: (max ?? 0) + 1,
    });
    return { ok: "create" } satisfies PaneActionResult;
  }

  const id = Number(form.get("id"));
  if (!Number.isInteger(id) || id <= 0) return fail("Unknown account.");

  if (intent === "update") {
    const parsed = readFields(form);
    if (!parsed.ok) return fail(parsed.error);

    // Switching an account to balance-only would strand any transactions it
    // already holds — they would stop counting toward its balance while still
    // sitting in reports. Make the user clear them out deliberately.
    if (parsed.fields.kind === "balance") {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, id));
      if ((row?.count ?? 0) > 0) {
        return fail(
          `This account has ${row.count} imported transaction${row.count === 1 ? "" : "s"}. Delete them before switching it to balance-only tracking.`,
        );
      }
    }

    // The mirror image: transfers may name this account as their far side
    // precisely because it keeps no ledger. Giving it one makes those links
    // meaningless — the opposite legs should be imported and paired instead.
    if (parsed.fields.kind === "transaction") {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.transferAccountId, id));
      if ((row?.count ?? 0) > 0) {
        return fail(
          `${row.count} transfer${row.count === 1 ? " names" : "s name"} this account as their far side, which only makes sense while it is balance-only. Unlink them before switching it to transaction tracking.`,
        );
      }
    }

    const updated = await db
      .update(schema.accounts)
      .set(parsed.fields)
      .where(eq(schema.accounts.id, id))
      .returning({ id: schema.accounts.id });
    if (updated.length === 0) return fail("That account no longer exists.");
    return { ok: "update" } satisfies PaneActionResult;
  }

  if (intent === "set-active") {
    await db
      .update(schema.accounts)
      .set({ isActive: form.get("isActive") === "true" })
      .where(eq(schema.accounts.id, id));
    return { ok: "set-active" } satisfies PaneActionResult;
  }

  if (intent === "move") {
    const direction = form.get("direction") === "up" ? -1 : 1;
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, id));
    if (!account) return fail("That account no longer exists.");

    // Reorder within the account's own group, since the navigator and the pane
    // both list transaction accounts and balance accounts separately.
    const siblings = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.kind, account.kind))
      .orderBy(schema.accounts.sortOrder, schema.accounts.name);

    const at = siblings.findIndex((s) => s.id === id);
    const swapWith = siblings[at + direction];
    if (!swapWith) return { ok: "move" } satisfies PaneActionResult; // already at the end

    // sortOrder defaults to 0 for every row, so normalize the group to its
    // current visible order first, then swap the two positions.
    const order = siblings.map((s) => s.id);
    [order[at], order[at + direction]] = [order[at + direction], order[at]];
    await db.transaction(async (tx) => {
      for (const [index, accountId] of order.entries()) {
        await tx.update(schema.accounts)
          .set({ sortOrder: index + 1 })
          .where(eq(schema.accounts.id, accountId))
          .run();
      }
    });
    return { ok: "move" } satisfies PaneActionResult;
  }

  if (intent === "delete") {
    // Deletion is only offered for accounts with no history at all; archiving
    // is the answer for everything else.
    const countFor = async (table: typeof schema.transactions | typeof schema.balanceSnapshots) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(table)
        .where(eq(table.accountId, id));
      return row?.count ?? 0;
    };
    const [existing] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, id));
    if (!existing) return fail("That account no longer exists.");
    const [txns, snapshots, batches, farSideLegs] = await Promise.all([
      countFor(schema.transactions),
      countFor(schema.balanceSnapshots),
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.importBatches)
        .where(eq(schema.importBatches.accountId, id))
        .then(([row]) => row?.count ?? 0),
      // A balance-only account can hold nothing of its own and still be the
      // named far side of transfers sitting in other accounts.
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.transferAccountId, id))
        .then(([row]) => row?.count ?? 0),
    ]);
    if (txns > 0 || snapshots > 0 || batches > 0) {
      return fail(
        "That account has history attached. Archive it instead of deleting it.",
      );
    }
    if (farSideLegs > 0) {
      return fail(
        `${farSideLegs} transfer${farSideLegs === 1 ? " is" : "s are"} linked to this account as their far side. Unlink them first, or archive the account instead.`,
      );
    }
    await db.transaction(async (tx) => {
      // Saved CSV column mappings are the only other rows pointing at it.
      await tx.delete(schema.csvMappings).where(eq(schema.csvMappings.accountId, id)).run();
      await tx.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
    });
    return { ok: "delete" } satisfies PaneActionResult;
  }

  return fail("Unknown action.");
}
