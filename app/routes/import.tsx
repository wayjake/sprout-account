import { Form, Link, data, redirect, useNavigation } from "react-router";
import { desc, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { intakeTransactions, isPdf, type IntakeResult } from "~/.server/import/intake";
import { createSession, dedupeSessionBatches } from "~/.server/import/stage";
import { formatDateRange } from "~/lib/dates";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  fileInputClass,
  selectClass,
} from "~/components/ui";
import type { Route } from "./+types/import";

export function meta() {
  return [{ title: "Transaction Import · Sprout Account — Household Ledger" }];
}

export async function loader(_: Route.LoaderArgs) {
  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.isActive, true))
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);
  const batches = await db
    .select({
      id: schema.importBatches.id,
      sessionId: schema.importBatches.sessionId,
      filename: schema.importBatches.filename,
      kind: schema.importBatches.kind,
      sourceType: schema.importBatches.sourceType,
      status: schema.importBatches.status,
      statsJson: schema.importBatches.statsJson,
      createdAt: schema.importBatches.createdAt,
      committedAt: schema.importBatches.committedAt,
      periodStart: schema.importBatches.periodStart,
      periodEnd: schema.importBatches.periodEnd,
      rowCount: schema.importBatches.rowCount,
      accountLabel: schema.importBatches.accountLabel,
      accountName: schema.accounts.name,
    })
    .from(schema.importBatches)
    .leftJoin(schema.accounts, eq(schema.importBatches.accountId, schema.accounts.id))
    .leftJoin(
      schema.importSessions,
      eq(schema.importBatches.sessionId, schema.importSessions.id),
    )
    // Statements belong to a close, and have their own history on /reconcile.
    .where(
      or(
        isNull(schema.importBatches.sessionId),
        eq(schema.importSessions.purpose, "import"),
      ),
    )
    .orderBy(desc(schema.importBatches.id))
    .limit(25);
  return { accounts, batches };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const accountId = Number(form.get("accountId"));
  const files = form
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);

  if (!accountId || files.length === 0) {
    return data(
      { error: "Pick a default account and at least one file." },
      { status: 400 },
    );
  }
  // Refuse the whole upload rather than half of it: a statement here is a
  // mistake about which screen you are on, not a bad file.
  const pdfs = files.filter(isPdf);
  if (pdfs.length > 0) {
    return data(
      {
        error: `${pdfs.map((f) => f.name).join(", ")} ${
          pdfs.length === 1 ? "is a PDF statement" : "are PDF statements"
        }. Statements are read during a month-end close — take them to Monthly Reconcile.`,
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

  const session = await createSession("import");

  const results: IntakeResult[] = [];
  for (const file of files) {
    results.push(
      await intakeTransactions({ sessionId: session.id, file, defaultAccount, accounts }),
    );
  }

  // Two files covering the same month must not both be committed
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

  // Nothing usable came out of the upload — say so on the upload page rather
  // than dumping the user on an empty review screen.
  if (failures.length === results.length) {
    return data(
      {
        error: `Could not read ${failures.length === 1 ? "that file" : "any of those files"}: ${failures
          .map((f) => `${f.filename} — ${f.error}`)
          .join("; ")}`,
      },
      { status: 400 },
    );
  }

  return redirect(`/import/session/${session.id}`);
}

const STATUS_STYLES: Record<string, string> = {
  mapping: "bg-class-living/15 text-class-living",
  review: "bg-class-living/15 text-class-living",
  committed: "bg-positive/15 text-positive",
  discarded: "bg-gray-200 text-gray-500",
};

export default function Import({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts, batches } = loaderData;
  const navigation = useNavigation();
  const uploading = navigation.state === "submitting";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-[16px] font-bold text-primary-950">📥 Transaction Import</h1>
        <p className="mt-1 text-sm text-gray-500">
          Transaction exports from your bank — upload as many as you like at once. This is
          how rows get into the register.{" "}
          <Link to="/reconcile" className="font-medium text-primary-600 hover:underline">
            PDF statements are read during a month-end close →
          </Link>
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}

      <Card>
        <CardHeader title="Upload transaction exports" />
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
            <Field label="Files (.csv — pick several)">
              <input
                type="file"
                name="files"
                multiple
                accept=".csv,.txt,text/csv"
                required
                className={fileInputClass}
              />
            </Field>
            <Button type="submit" disabled={uploading}>
              {uploading ? "Processing…" : "Upload"}
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            Each file is matched to an account by its filename — the default above is the
            fallback, and you can change it on the next screen. A file's columns are asked
            about once per account and remembered after that.
          </p>
        </Form>
      </Card>

      <Card>
        <CardHeader title="Import history" />
        {batches.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Nothing imported yet" />
          </div>
        ) : (
          <ul className="divide-y divide-primary-50">
            {batches.map((b) => {
              const stats = b.statsJson ? JSON.parse(b.statsJson) : {};
              const continueTo =
                b.status === "mapping"
                  ? `/import/${b.id}/map`
                  : b.sessionId
                    ? `/import/session/${b.sessionId}`
                    : `/import/${b.id}`;
              return (
                <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[b.status]}`}
                  >
                    {b.status}
                  </span>
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">
                      {b.filename}
                      {b.periodStart && b.periodEnd && (
                        <span className="ml-2 text-xs font-normal text-gray-500">
                          {formatDateRange(b.periodStart, b.periodEnd)}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      {b.accountLabel ?? b.accountName ?? "—"} ·{" "}
                      {b.sourceType.toUpperCase()}
                      {b.rowCount != null && ` · ${b.rowCount} rows detected`} ·{" "}
                      {new Date((b.committedAt ?? b.createdAt) * 1000).toLocaleDateString()}
                      {b.status === "committed" && stats.inserted != null && (
                        <>
                          {" "}· {stats.inserted} added
                          {stats.balancesRecorded > 0 &&
                            `, ${stats.balancesRecorded} balance${stats.balancesRecorded === 1 ? "" : "s"}`}
                          {stats.autoCategorized > 0 &&
                            `, ${stats.autoCategorized} auto-categorized`}
                          {stats.skipped > 0 && `, ${stats.skipped} skipped`}
                        </>
                      )}
                    </p>
                  </div>
                  {(b.status === "review" || b.status === "mapping") && (
                    <Link
                      to={continueTo}
                      className="text-xs font-medium text-primary-600 hover:underline"
                    >
                      Continue →
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
