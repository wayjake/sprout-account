import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Button, Field, inputClass, selectClass } from "~/components/ui";
import { ACCOUNT_TYPE_LABELS } from "~/lib/accounts";
import type { PaneActionResult } from "~/lib/panes";
import { ACCOUNT_TYPES, type Account } from "~/db/schema";

export const ACCOUNTS_ACTION = "/settings/accounts";

/** An account plus the counts that decide whether it can be deleted. */
export interface AccountPaneRow extends Account {
  txnCount: number;
  snapshotCount: number;
  batchCount: number;
}

export function AccountsPane({ accounts }: { accounts: AccountPaneRow[] }) {
  const fetcher = useFetcher<PaneActionResult>();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const addFormRef = useRef<HTMLFormElement>(null);
  const result = fetcher.state === "idle" ? fetcher.data : undefined;

  // Close the editor / clear the add form once the server confirms the write.
  useEffect(() => {
    if (!result?.ok) return;
    if (result.ok === "update") setEditingId(null);
    if (result.ok === "create") addFormRef.current?.reset();
    if (result.ok === "delete") setConfirmDeleteId(null);
  }, [result]);

  const groups = [
    {
      kind: "transaction" as const,
      title: "Transaction accounts",
      blurb: "Checking, savings and credit cards — tracked transaction by transaction.",
    },
    {
      kind: "balance" as const,
      title: "Balance-only accounts",
      blurb: "Investment and retirement accounts — tracked by statement balances.",
    },
  ];

  return (
    <div className="p-3">
      {/* Stable region so repeat failures still announce. */}
      <div role="alert">
        {result?.error && (
          <p className="groove mb-3 bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
            ⛔ {result.error}
          </p>
        )}
      </div>

      {groups.map((group) => {
        const rows = accounts.filter((a) => a.kind === group.kind);
        return (
          <section key={group.kind} className="mb-4">
            <h3 className="text-[12px] font-bold text-primary-900">{group.title}</h3>
            <p className="mb-1.5 text-[11px] text-gray-600">{group.blurb}</p>
            {rows.length === 0 ? (
              <p className="groove bg-white px-3 py-2 text-[11px] italic text-gray-600">
                None yet.
              </p>
            ) : (
              <ul className="groove divide-y divide-chrome-dark/30 bg-white">
                {rows.map((account, index) => (
                  <li key={account.id}>
                    {editingId === account.id ? (
                      <EditForm
                        account={account}
                        fetcher={fetcher}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <AccountRow
                        account={account}
                        fetcher={fetcher}
                        isFirst={index === 0}
                        isLast={index === rows.length - 1}
                        confirmingDelete={confirmDeleteId === account.id}
                        onEdit={() => {
                          setConfirmDeleteId(null);
                          setEditingId(account.id);
                        }}
                        onAskDelete={() => setConfirmDeleteId(account.id)}
                        onCancelDelete={() => setConfirmDeleteId(null)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <section className="groove bg-primary-50 p-3">
        <h3 className="mb-2 text-[12px] font-bold text-primary-900">Add an account</h3>
        <fetcher.Form
          ref={addFormRef}
          method="post"
          action={ACCOUNTS_ACTION}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="intent" value="create" />
          <Field label="Account name">
            <input
              name="name"
              placeholder="Household Checking"
              className={inputClass}
              required
            />
          </Field>
          <Field label="Institution">
            <input name="institution" placeholder="Chase" className={inputClass} required />
          </Field>
          <Field label="Type">
            <select name="accountType" className={`${selectClass} w-full`}>
              {ACCOUNT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ACCOUNT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Last four digits (optional)">
            <input
              name="lastFour"
              placeholder="1234"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
              className={inputClass}
            />
          </Field>
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit">Add account</Button>
          </div>
        </fetcher.Form>
        <p className="mt-2 text-[11px] text-gray-600">
          The last four digits help statement import match a file to the right account.
        </p>
      </section>
    </div>
  );
}

type PaneFetcher = ReturnType<typeof useFetcher<PaneActionResult>>;

function AccountRow({
  account,
  fetcher,
  isFirst,
  isLast,
  confirmingDelete,
  onEdit,
  onAskDelete,
  onCancelDelete,
}: {
  account: AccountPaneRow;
  fetcher: PaneFetcher;
  isFirst: boolean;
  isLast: boolean;
  confirmingDelete: boolean;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
}) {
  const isUsed =
    account.txnCount > 0 || account.snapshotCount > 0 || account.batchCount > 0;
  const usage = [
    account.txnCount > 0 && `${account.txnCount.toLocaleString()} transactions`,
    account.snapshotCount > 0 && `${account.snapshotCount} balance snapshots`,
    account.batchCount > 0 && `${account.batchCount} imports`,
  ].filter(Boolean) as string[];

  function submit(fields: Record<string, string>) {
    fetcher.submit(fields, { method: "post", action: ACCOUNTS_ACTION });
  }

  return (
    <div className={`px-2 py-1.5 ${account.isActive ? "" : "bg-chrome/40"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-bold text-primary-900">
            {account.name}
            {account.lastFour && (
              <span className="ml-1.5 font-normal text-gray-600">··{account.lastFour}</span>
            )}
            {!account.isActive && (
              <span className="ml-1.5 border border-black/30 bg-chrome px-1 text-[10px] font-bold uppercase text-gray-700">
                Archived
              </span>
            )}
          </p>
          <p className="truncate text-[11px] text-gray-600">
            {account.institution} · {ACCOUNT_TYPE_LABELS[account.accountType]}
            {usage.length > 0 && ` · ${usage.join(", ")}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-7"
            aria-label={`Move ${account.name} up`}
            disabled={isFirst}
            onClick={() => submit({ intent: "move", id: String(account.id), direction: "up" })}
          >
            <span aria-hidden>↑</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-7"
            aria-label={`Move ${account.name} down`}
            disabled={isLast}
            onClick={() =>
              submit({ intent: "move", id: String(account.id), direction: "down" })
            }
          >
            <span aria-hidden>↓</span>
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              submit({
                intent: "set-active",
                id: String(account.id),
                isActive: String(!account.isActive),
              })
            }
            title={
              account.isActive
                ? "Hide from the navigator and from new imports. History is kept."
                : "Show this account again."
            }
          >
            {account.isActive ? "Archive" : "Restore"}
          </Button>
          {!isUsed && !confirmingDelete && (
            <Button type="button" variant="danger" size="sm" onClick={onAskDelete}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {confirmingDelete && (
        <div className="groove mt-1.5 flex flex-wrap items-center gap-2 bg-[#ffefef] px-2 py-1.5">
          <p className="flex-1 text-[11px] font-bold text-negative">
            Delete “{account.name}” for good? It has no transactions, so nothing else is
            affected.
          </p>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => submit({ intent: "delete", id: String(account.id) })}
          >
            Yes, delete
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancelDelete}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function EditForm({
  account,
  fetcher,
  onCancel,
}: {
  account: AccountPaneRow;
  fetcher: PaneFetcher;
  onCancel: () => void;
}) {
  return (
    <fetcher.Form
      method="post"
      action={ACCOUNTS_ACTION}
      className="grid grid-cols-1 gap-2.5 bg-primary-50 p-2.5 sm:grid-cols-2"
    >
      <input type="hidden" name="intent" value="update" />
      <input type="hidden" name="id" value={account.id} />
      <Field label="Account name">
        <input name="name" defaultValue={account.name} className={inputClass} required autoFocus />
      </Field>
      <Field label="Institution">
        <input
          name="institution"
          defaultValue={account.institution}
          className={inputClass}
          required
        />
      </Field>
      <Field label="Type">
        <select
          name="accountType"
          defaultValue={account.accountType}
          className={`${selectClass} w-full`}
        >
          {ACCOUNT_TYPES.map((type) => (
            <option key={type} value={type}>
              {ACCOUNT_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Last four digits (optional)">
        <input
          name="lastFour"
          defaultValue={account.lastFour ?? ""}
          inputMode="numeric"
          maxLength={4}
          pattern="\d{4}"
          className={inputClass}
        />
      </Field>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit">
          Save changes
        </Button>
      </div>
      {account.txnCount > 0 && (
        <p className="text-[11px] text-gray-600 sm:col-span-2">
          Changing the type between transaction and balance tracking affects how this
          account’s {account.txnCount.toLocaleString()} existing transactions are reported.
        </p>
      )}
    </fetcher.Form>
  );
}
