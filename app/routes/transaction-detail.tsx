import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useFetcher,
  useLocation,
  useNavigate,
  useRouteLoaderData,
} from "react-router";
import type { Category } from "~/db/schema";
import { eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { applyItemSplits } from "~/.server/amazon";
import { clearedStateFor, clearedWindows } from "~/.server/balances";
import { categorizeTransactions, recordUserChoice } from "~/.server/categorize";
import { AiError } from "~/.server/openrouter";
import {
  neighborTransactions,
  parseTransactionFilters,
  type NeighborRow,
} from "~/.server/queries";
import {
  MANUAL_TRANSFER_WINDOW_DAYS,
  balanceTransferTargets,
  findCandidatesFor,
  linkTransferPair,
  linkTransferToAccount,
  manualPeerCandidates,
  pairTransferTargets,
  unlinkTransfer,
  unlinkTransferAccount,
} from "~/.server/transfers";
import { CategoryCombobox, CategoryOptions } from "~/components/category-picker";
import { PaneWindow } from "~/components/pane-window";
import {
  Amount,
  Button,
  Card,
  CardHeader,
  ClassBadge,
  ClearedMark,
  Field,
  inputClass,
  selectClass,
} from "~/components/ui";
import { ACCOUNT_TYPE_LABELS } from "~/lib/accounts";
import { formatDate } from "~/lib/dates";
import { centsToInput, formatCents, parseCentsInput } from "~/lib/money";
import type { loader as shellLoader } from "./shell";
import type { Route } from "./+types/transaction-detail";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: `${loaderData?.transaction.merchant ?? "Transaction"} · Sprout Account — Household Ledger` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const id = Number(params.id);
  const transaction = await db.query.transactions.findFirst({
    where: eq(schema.transactions.id, id),
    with: {
      account: true,
      category: true,
      transferPeer: { with: { account: true } },
      splits: { with: { category: true } },
      amazonMatches: {
        with: { order: { with: { items: { with: { category: true } } } } },
      },
    },
  });
  if (!transaction) throw data("Transaction not found", { status: 404 });
  // Once either kind of link is in place there is nothing left to choose.
  const linked = transaction.transferPeerId || transaction.transferAccountId;
  // Linking is only on the table once the row has been *called* a transfer.
  // Saying so is the first step and the picker is the second: nothing else on
  // this screen tells the difference between money moving between your own
  // accounts and money leaving the household, and the picker asking on every
  // uncategorized row buries the question. Import's `autoLinkTransfers` files
  // the pairs it is sure about, so this is the path for the rest.
  const transferable = transaction.category?.spendingClass === "transfer";
  const offerLink = !linked && transferable;
  const [
    transferCandidates,
    transferTargets,
    pairTargets,
    peerCandidates,
    transferAccount,
  ] = await Promise.all([
    offerLink ? findCandidatesFor(id) : [],
    offerLink ? balanceTransferTargets() : [],
    offerLink ? pairTransferTargets(transaction.accountId) : [],
    offerLink ? manualPeerCandidates(id) : [],
    transaction.transferAccountId
      ? db.query.accounts.findFirst({
          where: eq(schema.accounts.id, transaction.transferAccountId),
        })
      : null,
  ]);
  // Derived from the period this row sits in, not stored on the row.
  const windows = await clearedWindows();
  const accountWindows = windows.get(transaction.accountId);
  const cleared = clearedStateFor(accountWindows, transaction.date);
  const clearedWindow =
    accountWindows?.find(
      (w) => transaction.date > w.fromDate && transaction.date <= w.toDate,
    ) ?? null;

  // Previous / Next walk the register as it is filtered, and the register's
  // filters are in this window's own URL — they ride along in every link that
  // opens it.
  const neighbors = await neighborTransactions(
    parseTransactionFilters(new URL(request.url)),
    { date: transaction.date, id: transaction.id },
    windows,
  );

  return {
    transaction,
    neighbors,
    transferCandidates,
    transferTargets,
    pairTargets,
    peerCandidates,
    // Rendered in the picker's copy, and `.server` constants can't cross into
    // the client bundle, so it rides along as data.
    peerWindowDays: MANUAL_TRANSFER_WINDOW_DAYS,
    transferAccount: transferAccount ?? null,
    transferable,
    cleared,
    clearedWindow,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const id = Number(params.id);
  const form = await request.formData();
  const intent = form.get("intent");

  const [txn] = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id))
    .limit(1);
  if (!txn) throw data("Transaction not found", { status: 404 });

  if (intent === "update") {
    const date = String(form.get("date") ?? txn.date);
    const amountCents = parseCentsInput(String(form.get("amount") ?? ""));
    const notes = String(form.get("notes") ?? "").trim() || null;
    const categoryId = form.get("categoryId")
      ? Number(form.get("categoryId"))
      : null;
    if (amountCents == null) {
      return data({ error: "Invalid amount" }, { status: 400 });
    }
    await db
      .update(schema.transactions)
      .set({
        date,
        amountCents,
        notes,
        categoryId,
        // Saving *is* the confirmation, even when the category came back
        // unchanged. This window is the only place anything gets categorized
        // now, so leaving a suggestion at source `ai` because the user agreed
        // with it would mean a later AI pass could still overwrite the memory
        // row they just endorsed.
        categorySource: categoryId == null ? null : "user",
      })
      .where(eq(schema.transactions.id, id));
    if (categoryId) await recordUserChoice(txn.merchant, categoryId);
    return { ok: true };
  }

  if (intent === "ai-categorize") {
    // `categorizeTransactions` only looks at uncategorized rows, so running it
    // on a filed one would hand back an all-zero tally that reads as a no-op.
    if (txn.categoryId != null) {
      return data(
        { error: "This transaction already has a category. Clear it first to ask again." },
        { status: 400 },
      );
    }
    let stats;
    try {
      stats = await categorizeTransactions([id]);
    } catch (err) {
      // No API key, or the model refused — every AI feature has to survive that.
      if (err instanceof AiError) return data({ error: err.message }, { status: 502 });
      throw err;
    }
    // Which layer answered is worth saying: memory and the guard cost nothing,
    // and a row left uncategorized was a deliberate refusal, not a failure.
    const aiMessage =
      stats.fromRule > 0
        ? "Filed by rule — money coming off a debt is a payment or a credit, never income."
        : stats.fromMemory > 0
          ? "Filed from what you have chosen for this merchant before — no AI call needed."
          : stats.fromAi > 0
            ? "Filed by AI. Change it below if it guessed wrong; your choice is the one that gets remembered."
            : stats.blocked > 0
              ? "Left uncategorized on purpose: the suggestion was an income category on a debt account, which would be wrong. Pick one below."
              : "The AI wasn't confident enough to file this one. Pick a category below.";
    return { aiMessage };
  }

  if (intent === "save-splits") {
    const categoryIds = form.getAll("splitCategoryId").map(Number);
    const amounts = form.getAll("splitAmount").map((v) => parseCentsInput(String(v)));
    const memos = form.getAll("splitMemo").map((v) => String(v));
    const rows = categoryIds
      .map((categoryId, i) => ({
        transactionId: id,
        categoryId,
        amountCents: amounts[i]!,
        memo: memos[i]?.trim() || null,
      }))
      .filter((r) => r.categoryId && r.amountCents != null && r.amountCents !== 0);
    if (rows.length < 2) {
      return data({ error: "A split needs at least two lines" }, { status: 400 });
    }
    const sum = rows.reduce((acc, r) => acc + r.amountCents!, 0);
    if (sum !== txn.amountCents) {
      return data(
        {
          error: `Split lines total ${formatCents(sum)} but the transaction is ${formatCents(
            txn.amountCents,
          )}. They must match exactly.`,
        },
        { status: 400 },
      );
    }
    await db.transaction(async (tx) => {
      await tx.delete(schema.transactionSplits)
        .where(eq(schema.transactionSplits.transactionId, id))
        .run();
      await tx.insert(schema.transactionSplits)
        .values(rows as (typeof schema.transactionSplits.$inferInsert)[])
        .run();
    });
    return { ok: true };
  }

  if (intent === "clear-splits") {
    await db
      .delete(schema.transactionSplits)
      .where(eq(schema.transactionSplits.transactionId, id));
    return { ok: true };
  }

  if (intent === "set-item-category") {
    const itemId = Number(form.get("itemId"));
    const categoryId = form.get("categoryId") ? Number(form.get("categoryId")) : null;
    await db
      .update(schema.amazonOrderItems)
      .set({ categoryId })
      .where(eq(schema.amazonOrderItems.id, itemId));
    return { ok: true };
  }

  if (intent === "apply-item-splits") {
    const error = await applyItemSplits(id);
    if (error) return data({ error }, { status: 400 });
    return { ok: true };
  }

  if (intent === "link-transfer") {
    const peerId = Number(form.get("peerId"));
    const [outId, inId] = txn.amountCents < 0 ? [id, peerId] : [peerId, id];
    const error = await linkTransferPair(outId, inId, "user");
    if (error) return data({ error }, { status: 400 });
    return { ok: true };
  }

  if (intent === "unlink-transfer") {
    await unlinkTransfer(id);
    return { ok: true };
  }

  if (intent === "link-transfer-account") {
    const accountId = Number(form.get("accountId"));
    if (!accountId) return data({ error: "Pick an account." }, { status: 400 });
    const error = await linkTransferToAccount(id, accountId, "user");
    if (error) return data({ error }, { status: 400 });
    return { ok: true };
  }

  if (intent === "unlink-transfer-account") {
    await unlinkTransferAccount(id);
    return { ok: true };
  }

  if (intent === "delete") {
    // db:push created transfer_peer_id without its FK (SQLite can't add one
    // in-place), so clear the surviving leg's pointer ourselves.
    await db
      .update(schema.transactions)
      .set({ transferPeerId: null })
      .where(eq(schema.transactions.transferPeerId, id));
    await db.delete(schema.transactions).where(eq(schema.transactions.id, id));
    // Back to the register the window was opened over — filters and all.
    return redirect(`/transactions${new URL(request.url).search}`);
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

/**
 * One step along the register, in the order it is filtered. A missing
 * neighbour is the end of the list, so the control stays put and goes dead
 * rather than disappearing and shifting the other one across.
 */
function NeighborButton({
  row,
  direction,
  search,
}: {
  row: NeighborRow | null;
  direction: "previous" | "next";
  search: string;
}) {
  const label = direction === "previous" ? "◀ Previous" : "Next ▶";
  if (!row) {
    return (
      <Button variant="secondary" size="sm" disabled>
        {label}
      </Button>
    );
  }
  return (
    <Link
      to={`/transactions/${row.id}${search}`}
      className="bevel-btn inline-flex items-center gap-1.5 px-2.5 py-[3px] text-[11px] text-black"
      title={`${formatDate(row.date)} · ${row.merchant}`}
    >
      {label}
    </Link>
  );
}

/**
 * The layered categorizer, run on one row: the debt-credit rule, then merchant
 * memory, then the AI — the same order and the same guards as the bulk pass.
 */
function AiCategorizeButton({
  fetcher,
}: {
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="ai-categorize" />
      <Button
        size="sm"
        variant="secondary"
        type="submit"
        disabled={fetcher.state !== "idle"}
      >
        {fetcher.state !== "idle" ? "Thinking…" : "🔮 Suggest a category"}
      </Button>
    </fetcher.Form>
  );
}

/**
 * Whether saving should walk on to the next row. A preference, not page state:
 * the whole point is that it survives the move to the next transaction, and
 * this window remounts on the way there. Read after mount so the server and the
 * first client render agree.
 */
const AUTO_NEXT_KEY = "sprout:auto-next";

function useAutoNext() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(localStorage.getItem(AUTO_NEXT_KEY) === "1");
  }, []);
  return [
    on,
    (next: boolean) => {
      setOn(next);
      localStorage.setItem(AUTO_NEXT_KEY, next ? "1" : "0");
    },
  ] as const;
}

function ItemSplitButton() {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="apply-item-splits" />
      <Button size="sm" variant="secondary" type="submit" disabled={fetcher.state !== "idle"}>
        {fetcher.state !== "idle" ? "Splitting…" : "Apply items as splits"}
      </Button>
    </fetcher.Form>
  );
}

function ItemCategoryPicker({
  item,
  categories,
}: {
  item: { id: number; categoryId: number | null };
  categories: Category[];
}) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="set-item-category" />
      <input type="hidden" name="itemId" value={item.id} />
      <select
        name="categoryId"
        defaultValue={item.categoryId ?? ""}
        onChange={(e) => fetcher.submit(e.currentTarget.form)}
        className="max-w-36 rounded-md border border-primary-200 bg-white px-1.5 py-1 text-xs"
      >
        <option value="">— inherit —</option>
        <CategoryOptions categories={categories} />
      </select>
    </fetcher.Form>
  );
}

type LoaderTransferData = Awaited<ReturnType<typeof loader>>;

/**
 * Naming the far side of a transfer. Two shapes, one picker: an account that
 * keeps its own transactions has a *row* on the other side, so picking it
 * lists that account's opposite-amount rows to pair with; a balance-only
 * account has no row at all, so the link names the account itself.
 */
function TransferPicker({
  txn,
  transferCandidates,
  pairTargets,
  peerCandidates,
  peerWindowDays,
  transferTargets,
}: {
  txn: { id: number; amountCents: number; account: { name: string } };
  transferCandidates: LoaderTransferData["transferCandidates"];
  pairTargets: LoaderTransferData["pairTargets"];
  peerCandidates: LoaderTransferData["peerCandidates"];
  peerWindowDays: number;
  transferTargets: LoaderTransferData["transferTargets"];
}) {
  const [picked, setPicked] = useState("");
  const [kind, accountIdText] = picked.split(":");
  const accountId = Number(accountIdText);
  const pairAccount =
    kind === "pair" ? pairTargets.find((a) => a.id === accountId) : undefined;
  const balanceAccount =
    kind === "balance"
      ? transferTargets.find((a) => a.id === accountId)
      : undefined;
  const rows = pairAccount
    ? peerCandidates.filter((c) => c.accountId === pairAccount.id)
    : [];

  return (
    <div className="space-y-3">
      {transferCandidates.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            This looks like it could be one leg of a transfer between your own
            accounts. Linking it pairs the two legs and keeps both out of income
            and spending.
          </p>
          {transferCandidates.map((c) => {
            const other = c.out.id === txn.id ? c.in : c.out;
            return (
              <div key={other.id} className="flex items-center gap-3">
                <span
                  className="min-w-0 flex-1 truncate text-sm text-gray-700"
                  title={other.description}
                >
                  <span className="font-bold">{other.accountName}</span> ·{" "}
                  {formatDate(other.date)} · {other.description}
                </span>
                <Amount cents={other.amountCents} />
                <Form method="post">
                  <input type="hidden" name="intent" value="link-transfer" />
                  <input type="hidden" name="peerId" value={other.id} />
                  <Button size="sm" variant="secondary" type="submit">
                    ⇄ Link
                  </Button>
                </Form>
              </div>
            );
          })}
        </div>
      )}

      {(pairTargets.length > 0 || transferTargets.length > 0) && (
        <div
          className={
            transferCandidates.length > 0
              ? "border-t border-primary-100 pt-3"
              : ""
          }
        >
          {/* Named, not just "another account": the near side is this row's own
              account and is deliberately absent from the list, which reads as a
              missing account unless the list says what it is a list of. */}
          <Field label={`Moved to / from — the far side of this ${txn.account.name} row`}>
            <select
              value={picked}
              onChange={(e) => setPicked(e.currentTarget.value)}
              className={`${selectClass} w-full`}
            >
              <option value="">— pick an account —</option>
              {pairTargets.length > 0 && (
                <optgroup label="Keeps its own transactions">
                  {pairTargets.map((a) => (
                    <option key={a.id} value={`pair:${a.id}`}>
                      {a.name} ({ACCOUNT_TYPE_LABELS[a.accountType].toLowerCase()})
                    </option>
                  ))}
                </optgroup>
              )}
              {transferTargets.length > 0 && (
                <optgroup label="Tracked by balance only">
                  {transferTargets.map((a) => (
                    <option key={a.id} value={`balance:${a.id}`}>
                      {a.name} ({ACCOUNT_TYPE_LABELS[a.accountType].toLowerCase()})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
        </div>
      )}

      {pairAccount && (
        <div className="space-y-2">
          {rows.length > 0 ? (
            <>
              <p className="text-xs text-gray-500">
                Rows in {pairAccount.name} for{" "}
                <Amount cents={-txn.amountCents} /> within{" "}
                {peerWindowDays} days. Pick the one that is the
                other half of this movement — both legs then drop out of income
                and spending.
              </p>
              {rows.map((c) => (
                <div key={c.id} className="flex items-center gap-3">
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-gray-700"
                    title={c.description}
                  >
                    {formatDate(c.date)} · {c.description}
                    {c.categoryName && (
                      <span className="ml-1.5 text-xs text-gray-500">
                        (filed as {c.categoryName} — linking refiles it)
                      </span>
                    )}
                  </span>
                  <Amount cents={c.amountCents} />
                  <Form method="post">
                    <input type="hidden" name="intent" value="link-transfer" />
                    <input type="hidden" name="peerId" value={c.id} />
                    <Button size="sm" variant="secondary" type="submit">
                      ⇄ Link
                    </Button>
                  </Form>
                </div>
              ))}
            </>
          ) : (
            <p className="text-xs text-gray-500">
              No {formatCents(-txn.amountCents)} row in {pairAccount.name} within{" "}
              {peerWindowDays} days that is free to link. The two
              legs of a transfer have to be equal and opposite, and neither can
              already belong to another transfer — import the other side, or fix
              its amount or date first.
            </p>
          )}
        </div>
      )}

      {balanceAccount && (
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="intent" value="link-transfer-account" />
          <input type="hidden" name="accountId" value={balanceAccount.id} />
          <p className="min-w-0 flex-1 text-xs text-gray-500">
            {balanceAccount.name} is tracked by balance only, so it never
            produces an opposite row to pair with. Naming the account here keeps
            this out of spending and lets the balances page tell contributions
            apart from market movement.
          </p>
          <Button size="sm" variant="secondary" type="submit">
            Link
          </Button>
        </Form>
      )}
    </div>
  );
}

export default function TransactionDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    transaction: txn,
    neighbors,
    transferCandidates,
    transferTargets,
    pairTargets,
    peerCandidates,
    peerWindowDays,
    transferAccount,
    transferable,
    cleared,
    clearedWindow,
  } = loaderData;
  const shell = useRouteLoaderData<typeof shellLoader>("routes/shell");
  const categories = shell?.categories ?? [];
  const [splitting, setSplitting] = useState(txn.splits.length > 0);
  const [splitLines, setSplitLines] = useState(
    Math.max(txn.splits.length, 2),
  );
  const confirmedMatches = txn.amazonMatches.filter(
    (m) => m.status === "confirmed",
  );
  const aiFetcher = useFetcher<{ aiMessage?: string; error?: string }>();
  const saveFetcher = useFetcher<{ ok?: true; error?: string }>();
  const [autoNext, setAutoNext] = useAutoNext();
  const navigate = useNavigate();
  const { search } = useLocation();
  // Closing is a navigation, not a `dialog.close()`: the URL is what opens and
  // shuts this window. The register's filters ride in the search string, so
  // going back to the list means going back to the same page of it.
  const close = () => navigate({ pathname: "/transactions", search });

  // Auto-advance: one save, one step down the list. Compared by identity
  // against the last result acted on — the window stays mounted while the id in
  // the URL changes, so a stale `fetcher.data` would otherwise walk the whole
  // register on one click.
  const advancedOn = useRef<unknown>(null);
  // Filing a row as a transfer is what makes the transfer picker appear, and it
  // appears on this render — walking away now would hand out an instruction and
  // then make it impossible to follow.
  const awaitingLink =
    txn.category?.spendingClass === "transfer" &&
    !txn.transferPeerId &&
    !txn.transferAccountId;
  useEffect(() => {
    if (saveFetcher.state !== "idle") return;
    const result = saveFetcher.data;
    if (!result || advancedOn.current === result) return;
    advancedOn.current = result;
    if (autoNext && result.ok && !awaitingLink && neighbors.next) {
      navigate(`/transactions/${neighbors.next.id}${search}`);
    }
  }, [
    saveFetcher.state,
    saveFetcher.data,
    autoNext,
    awaitingLink,
    neighbors.next,
    navigate,
    search,
  ]);

  // Unlike the settings panes, this dialog unmounts when it closes, so the
  // platform's focus restoration never runs. The opener is captured during
  // render — `showModal()` in the child effect has already moved focus by the
  // time this component's own effects run — and refocused on the way out.
  const opener = useRef<Element | null>(null);
  if (opener.current === null && typeof document !== "undefined") {
    opener.current = document.activeElement;
  }
  useEffect(
    () => () => {
      const el = opener.current;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    },
    [],
  );

  return (
    // Titled generically, like the settings panes: the merchant is already the
    // heading inside, and a titlebar that repeats it reads as a stutter.
    <PaneWindow open title="🧾 Transaction" width="46rem" onClose={close}>
      {/* Keyed on the row. Previous/Next only changes the `:id` in the URL, so
          this window stays mounted across the move — and every uncontrolled
          field in it (date, amount, notes, split lines) would keep the *last*
          row's value while showing the new row's heading. Saving then writes
          the old amount onto the new transaction and silently throws the
          period out of balance. Keying here remounts the whole body per row,
          which also resets the transfer picker's chosen account.
          Deliberately inside PaneWindow, not on it: remounting the <dialog>
          would re-run showModal() and yank focus on every step. */}
      <div key={txn.id} className="space-y-5 p-4">
        {/* Step through the register without closing the window — same order,
            same filters as the list underneath. */}
        <nav
          aria-label="Move through the filtered register"
          className="flex items-center justify-between gap-2"
        >
          <NeighborButton
            row={neighbors.previous}
            direction="previous"
            search={search}
          />
          <label className="flex items-center gap-1.5 text-[11px] text-gray-700">
            <input
              type="checkbox"
              checked={autoNext}
              onChange={(e) => setAutoNext(e.currentTarget.checked)}
            />
            Go to next after saving
          </label>
          <NeighborButton row={neighbors.next} direction="next" search={search} />
        </nav>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[16px] font-bold text-primary-950">{txn.merchant}</h1>
            <p className="text-sm text-gray-500">
              {txn.description} · {txn.account.name} · {formatDate(txn.date)}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-600">
              <ClearedMark state={cleared} />
              {clearedWindow ? (
                <>
                  {cleared === "reconciled" ? "Reconciled" : "In a period that is off"} —{" "}
                  {formatDate(clearedWindow.fromDate)} →{" "}
                  {formatDate(clearedWindow.toDate)}
                  {cleared === "mismatch" && (
                    <Link
                      to="/balances"
                      className="font-medium text-primary-600 hover:underline"
                    >
                      what's off →
                    </Link>
                  )}
                </>
              ) : (
                <>
                  Not yet reconciled — no closed statement period covers this date.{" "}
                  <Link
                    to="/reconcile"
                    className="font-medium text-primary-600 hover:underline"
                  >
                    Close a month →
                  </Link>
                </>
              )}
            </p>
          </div>
          <div className="text-right">
            <Amount cents={txn.amountCents} bold />
            {txn.category && (
              <div className="mt-1">
                <ClassBadge spendingClass={txn.category.spendingClass} />
              </div>
            )}
          </div>
        </div>

        {actionData && "error" in actionData && (
          <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
            {actionData.error}
          </p>
        )}

        <Card>
          <CardHeader title="Details">
            {/* Only offered while there is nothing filed — the categorizer
                skips rows that already have a category. */}
            {txn.categoryId == null && <AiCategorizeButton fetcher={aiFetcher} />}
          </CardHeader>
          {aiFetcher.data && (
            <p
              className={`px-4 pt-3 text-[11px] ${
                aiFetcher.data.error ? "font-bold text-negative" : "text-gray-600"
              }`}
              role="status"
            >
              {aiFetcher.data.error ?? aiFetcher.data.aiMessage}
            </p>
          )}
          {saveFetcher.data?.error && (
            <p className="px-4 pt-3 text-[11px] font-bold text-negative" role="status">
              {saveFetcher.data.error}
            </p>
          )}
          {/* A fetcher rather than a navigation submit: saving has to report
              back here so auto-advance knows it landed. */}
          <saveFetcher.Form method="post" className="grid grid-cols-2 gap-3 p-4">
            <input type="hidden" name="intent" value="update" />
            <Field label="Date">
              <input type="date" name="date" defaultValue={txn.date} className={inputClass} />
            </Field>
            <Field label="Amount (negative = spend)">
              <input
                name="amount"
                defaultValue={centsToInput(txn.amountCents)}
                className={inputClass}
              />
            </Field>
            {/* Keyed on the stored category: the picker holds its own state, so
                a category filed by the AI button has to remount it. */}
            <CategoryCombobox
              key={txn.categoryId ?? "none"}
              name="categoryId"
              label="Category"
              categories={categories}
              value={txn.categoryId}
              emphasizeEmpty
              placeholder="Type to search categories…"
            />
            <div className="col-span-2">
              <Field label="Notes">
                <input name="notes" defaultValue={txn.notes ?? ""} className={inputClass} />
              </Field>
            </div>
            <div className="col-span-2 flex items-center justify-end gap-3">
              {autoNext && neighbors.next && (
                <span className="text-[11px] text-gray-500">
                  Saving moves on to {neighbors.next.merchant}.
                </span>
              )}
              <Button type="submit" disabled={saveFetcher.state !== "idle"}>
                {saveFetcher.state !== "idle" ? "Saving…" : "Save"}
              </Button>
            </div>
          </saveFetcher.Form>
        </Card>

        <Card>
          <CardHeader title="⇄ Transfer link" />
          <div className="p-4">
            {!transferable && !transferAccount && !txn.transferPeer ? (
              // Not called a transfer, so there is nothing here to name yet.
              // Said rather than hidden: a card that comes and goes with the
              // category reads as a glitch.
              <p className="text-sm text-gray-500">
                {txn.category ? (
                  <>
                    This is filed as{" "}
                    <span className="font-bold text-gray-700">{txn.category.name}</span>{" "}
                    — spending or income, rather than money moving between your own
                    accounts.
                  </>
                ) : (
                  <>This isn't filed under a transfer category.</>
                )}{" "}
                Pick one above and save, and the other side of the movement can be
                named here.
              </p>
            ) : transferAccount ? (
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-sm text-gray-700">
                  Far side:{" "}
                  <span className="font-bold text-primary-700">
                    {transferAccount.name}
                  </span>{" "}
                  · {ACCOUNT_TYPE_LABELS[transferAccount.accountType].toLowerCase()}
                  <span className="mt-1 block text-xs text-gray-500">
                    That account is tracked by balance only, so there is no opposite
                    row to pair with. This counts as neither income nor spending, and
                    the balances page measures it against what the statements show.
                  </span>
                </p>
                <Form method="post">
                  <input type="hidden" name="intent" value="unlink-transfer-account" />
                  <Button variant="ghost" size="sm" type="submit">
                    Unlink
                  </Button>
                </Form>
              </div>
            ) : txn.transferPeer ? (
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-sm text-gray-700">
                  Opposite leg:{" "}
                  <Link
                    to={`/transactions/${txn.transferPeer.id}${search}`}
                    className="font-bold text-primary-700 hover:underline"
                  >
                    {txn.transferPeer.account.name}
                  </Link>{" "}
                  · {formatDate(txn.transferPeer.date)} ·{" "}
                  <Amount cents={txn.transferPeer.amountCents} />
                  <span className="mt-1 block text-xs text-gray-500">
                    Linked transfers count as neither income nor spending.
                  </span>
                </p>
                <Form method="post">
                  <input type="hidden" name="intent" value="unlink-transfer" />
                  <Button variant="ghost" size="sm" type="submit">
                    Unlink
                  </Button>
                </Form>
              </div>
            ) : pairTargets.length > 0 || transferTargets.length > 0 ? (
              <TransferPicker
                txn={txn}
                transferCandidates={transferCandidates}
                pairTargets={pairTargets}
                peerCandidates={peerCandidates}
                peerWindowDays={peerWindowDays}
                transferTargets={transferTargets}
              />
            ) : (
              <p className="text-sm text-gray-500">
                There is no other active account to move this to or from.
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Splits">
            {txn.splits.length > 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="clear-splits" />
                <Button variant="ghost" size="sm" type="submit">
                  Clear splits
                </Button>
              </Form>
            )}
          </CardHeader>
          <div className="p-4">
            {!splitting ? (
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">
                  Split this transaction across multiple categories — the lines replace
                  the whole transaction in reports.
                </p>
                <Button variant="secondary" size="sm" onClick={() => setSplitting(true)}>
                  Split…
                </Button>
              </div>
            ) : (
              <Form method="post" className="space-y-2">
                <input type="hidden" name="intent" value="save-splits" />
                {Array.from({ length: splitLines }).map((_, i) => {
                  const existing = txn.splits[i];
                  return (
                    <div key={i} className="flex gap-2">
                      <CategoryCombobox
                        name="splitCategoryId"
                        ariaLabel={`Split line ${i + 1} category`}
                        categories={categories}
                        value={existing?.categoryId ?? null}
                        allowClear={false}
                        placeholder="— category —"
                        className="flex-1"
                      />
                      <input
                        name="splitAmount"
                        defaultValue={existing ? centsToInput(existing.amountCents) : ""}
                        placeholder="-12.34"
                        className={`${inputClass} w-28`}
                      />
                      <input
                        name="splitMemo"
                        defaultValue={existing?.memo ?? ""}
                        placeholder="memo"
                        className={`${inputClass} w-40`}
                      />
                    </div>
                  );
                })}
                <div className="flex items-center justify-between pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSplitLines((n) => n + 1)}
                  >
                    + Add line
                  </Button>
                  <p className="text-xs text-gray-500">
                    Lines must total <Amount cents={txn.amountCents} />
                  </p>
                  <Button type="submit" variant="secondary" size="sm">
                    Save splits
                  </Button>
                </div>
              </Form>
            )}
          </div>
        </Card>

        {confirmedMatches.length > 0 && (
          <Card>
            <CardHeader title="Matched Amazon orders">
              <ItemSplitButton />
            </CardHeader>
            <div className="divide-y divide-primary-50">
              {confirmedMatches.map((m) => (
                <div key={m.id} className="p-4">
                  <p className="text-xs font-medium text-gray-500">
                    Order {m.order.orderId} · {formatDate(m.order.orderDate)} ·{" "}
                    {formatCents(m.order.totalCents)}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {m.order.items.map((item) => (
                      <li key={item.id} className="flex items-center gap-3 text-sm">
                        <span className="flex-1 truncate text-gray-700" title={item.description}>
                          {item.description}
                        </span>
                        <ItemCategoryPicker item={item} categories={categories} />
                        <span className="w-20 shrink-0 text-right tabular-nums text-gray-500">
                          {formatCents(item.totalCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="border-t border-primary-100 px-4 py-2.5 text-xs text-gray-500">
              "Apply items as splits" categorizes this charge item-by-item — tax and
              shipping are spread proportionally so the split totals match exactly.
            </p>
          </Card>
        )}

        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm("Delete this transaction?")) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <Button variant="danger" size="sm" type="submit">
            Delete transaction
          </Button>
        </Form>
      </div>
    </PaneWindow>
  );
}
