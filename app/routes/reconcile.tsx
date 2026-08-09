import { Form, Link, data, redirect, useNavigation } from "react-router";
import { eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { intakeStatement, isPdf, type IntakeResult } from "~/.server/import/intake";
import { createSession, dedupeSessionBatches } from "~/.server/import/stage";
import { closeHistory } from "~/.server/reconcile";
import { reconcileAccounts } from "~/.server/balances";
import { ReconcilePanel } from "~/components/reconciliation";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  fileInputClass,
  selectClass,
} from "~/components/ui";
import { formatDateRange } from "~/lib/dates";
import type { Route } from "./+types/reconcile";

export function meta() {
  return [{ title: "Monthly Reconcile · Sprout Account — Household Ledger" }];
}

export async function loader(_: Route.LoaderArgs) {
  const [accounts, history, reconciliation] = await Promise.all([
    db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.isActive, true))
      .orderBy(schema.accounts.sortOrder, schema.accounts.name),
    closeHistory(),
    reconcileAccounts(),
  ]);
  return { accounts, history, reconciliation };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const accountId = Number(form.get("accountId"));
  const files = form
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);

  if (!accountId || files.length === 0) {
    return data(
      { error: "Pick a default account and at least one statement." },
      { status: 400 },
    );
  }
  // Refuse the whole upload rather than half of it: a CSV here is a mistake
  // about which screen you are on, not a bad file.
  const notPdf = files.filter((f) => !isPdf(f));
  if (notPdf.length > 0) {
    return data(
      {
        error: `A month-end close reads PDF statements only — ${notPdf
          .map((f) => f.name)
          .join(", ")} ${notPdf.length === 1 ? "is not one" : "are not"}. Transaction exports go to Transaction Import.`,
      },
      { status: 400 },
    );
  }

  const defaultAccount = await db.query.accounts.findFirst({
    where: eq(schema.accounts.id, accountId),
  });
  if (!defaultAccount) return data({ error: "Account not found." }, { status: 404 });

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.isActive, true));

  const session = await createSession("reconcile");

  // Sequential: extraction is an AI call per statement and running them at once
  // invites rate limits for no real gain on a handful of files.
  const results: IntakeResult[] = [];
  for (const file of files) {
    results.push(
      await intakeStatement({ sessionId: session.id, file, defaultAccount, accounts }),
    );
  }

  // Two statements covering the same month must not both claim the same rows
  await dedupeSessionBatches(session.id);

  const failures = results.filter((r) => r.outcome === "error");
  if (failures.length > 0) {
    await db
      .update(schema.importSessions)
      .set({
        notesJson: JSON.stringify(
          failures.map((f) => ({ filename: f.filename, error: f.error })),
        ),
      })
      .where(eq(schema.importSessions.id, session.id));
  }

  if (failures.length === results.length) {
    return data(
      {
        error: `Could not read ${failures.length === 1 ? "that statement" : "any of those statements"}: ${failures
          .map((f) => `${f.filename} — ${f.error}`)
          .join("; ")}`,
      },
      { status: 400 },
    );
  }

  return redirect(`/reconcile/${session.id}`);
}

export default function Reconcile({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts, history, reconciliation } = loaderData;
  const navigation = useNavigation();
  const uploading = navigation.state === "submitting";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-[16px] font-bold text-primary-950">⚖️ Monthly Reconcile</h1>
        <p className="mt-1 text-sm text-gray-500">
          Close the month against your statements. Each statement's closing balance is
          recorded, and every line on it is checked off against the register — whatever
          the books turn out to be missing is listed for you to add.
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}

      <Card>
        <CardHeader title="Upload statements" />
        <Form method="post" encType="multipart/form-data" className="space-y-3 p-4">
          <div className="flex items-end gap-3">
            <Field label="Default account">
              <select name="accountId" className={selectClass} required>
                <option value="">Choose…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.institution})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Statements (.pdf — pick several)">
              <input
                type="file"
                name="files"
                multiple
                accept=".pdf,application/pdf"
                required
                className={fileInputClass}
              />
            </Field>
            <Button type="submit" disabled={uploading}>
              {uploading ? "Reading…" : "Start close"}
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            Each statement is matched to an account by its filename or the account number
            printed on it — the default above is the fallback.{" "}
            <Link to="/import" className="font-medium text-primary-600 hover:underline">
              Transaction exports (.csv) are imported separately →
            </Link>
          </p>
        </Form>
        {uploading && (
          <p className="px-4 pb-4 text-xs text-gray-500">
            Statements are sent to the AI for extraction — with several files this can take
            a few minutes.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="⚖️ Where the books stand" />
        <div className="bg-ledger p-3">
          <ReconcilePanel
            results={reconciliation}
            emptyMessage="No known balances yet. Upload a statement above and its closing balance becomes the figure everything since is measured against."
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Past closes" />
        {history.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No month has been closed yet" />
          </div>
        ) : (
          <ul className="divide-y divide-primary-50">
            {history.map((h) => (
              <li key={h.sessionId} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    h.status === "committed"
                      ? "bg-positive/15 text-positive"
                      : h.status === "discarded"
                        ? "bg-gray-200 text-gray-500"
                        : "bg-class-living/15 text-class-living"
                  }`}
                >
                  {h.status === "open" ? "in progress" : h.status}
                </span>
                <div className="flex-1">
                  <p className="font-medium text-gray-900">
                    {h.periodStart && h.periodEnd
                      ? formatDateRange(h.periodStart, h.periodEnd)
                      : // A session row is written before its statements are
                        // extracted, so an open close with no batches yet is a
                        // read still in flight — not a statement without a period.
                        h.statements === 0 && h.status === "open"
                        ? "Reading statements…"
                        : "No period detected"}
                    {!(h.statements === 0 && h.status === "open") && (
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        {h.statements} statement{h.statements === 1 ? "" : "s"}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {h.accounts.join(", ") || "—"} ·{" "}
                    {new Date((h.committedAt ?? h.createdAt) * 1000).toLocaleDateString()}
                    {h.status === "committed" && (
                      <>
                        {" "}
                        · {h.balancesRecorded} balance
                        {h.balancesRecorded === 1 ? "" : "s"} recorded
                        {h.inserted > 0 && `, ${h.inserted} missing rows added`}
                      </>
                    )}
                  </p>
                </div>
                <Link
                  to={`/reconcile/${h.sessionId}`}
                  className="text-xs font-medium text-primary-600 hover:underline"
                >
                  {h.status === "open" ? "Continue →" : "View →"}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
