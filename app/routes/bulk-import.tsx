import { Form, Link, data, redirect, useNavigation } from "react-router";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { MAX_BULK_FILES, createBulkRun } from "~/.server/import/bulk";
import { Badge, Button, Card, CardHeader, EmptyState } from "~/components/ui";
import type { Route } from "./+types/bulk-import";

export function meta() {
  return [{ title: "Bulk Statement Import · Sprout Account — Household Ledger" }];
}

export async function loader(_: Route.LoaderArgs) {
  // Past runs, with how many statements each carried. A bulk run is not a
  // month-end close and deliberately does not appear in "Past closes".
  const runs = await db
    .select({
      id: schema.importSessions.id,
      status: schema.importSessions.status,
      createdAt: schema.importSessions.createdAt,
      committedAt: schema.importSessions.committedAt,
      files: sql<number>`(
        select count(*) from bulk_files where bulk_files.session_id = import_sessions.id
      )`.mapWith(Number),
    })
    .from(schema.importSessions)
    .where(eq(schema.importSessions.purpose, "bulk"))
    .orderBy(desc(schema.importSessions.id))
    .limit(12);
  return { runs };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const files = form
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length === 0) {
    return data({ error: "Pick a folder with some statements in it." }, { status: 400 });
  }
  if (files.length > MAX_BULK_FILES) {
    return data(
      {
        error: `That folder holds ${files.length} files. ${MAX_BULK_FILES} is the most one run takes — split it into a couple of folders and run them one after the other.`,
      },
      { status: 400 },
    );
  }

  const uploads = files.map((file) => ({
    name: file.name,
    // A folder upload arrives with each file's place in the folder as its
    // multipart *filename* — `webkitRelativePath` is a browser-side property
    // that does not survive the wire, so the name is the only place the path
    // exists on the server. Two `statement.pdf`s in different subfolders are
    // otherwise indistinguishable, and folder consensus scopes by this: a null
    // relPath widens "the rest of this folder" to the whole run.
    relPath: file.name.includes("/") ? file.name : null,
    read: async () => Buffer.from(await file.arrayBuffer()),
  }));

  // An unchecked checkbox submits nothing at all, so these must test for the
  // value being present rather than for an absent "off".
  const run = await createBulkRun(uploads, {
    autoCreate: form.get("autoCreate") === "on",
    autoCommit: form.get("autoCommit") === "on",
  });

  if (run.accepted === 0) {
    return data(
      {
        error: `Nothing in that folder was a PDF statement (${run.skipped
          .slice(0, 5)
          .join(", ")}${run.skipped.length > 5 ? ", …" : ""}).`,
      },
      { status: 400 },
    );
  }

  return redirect(`/import/bulk/${run.sessionId}`);
}

export default function BulkImport({ loaderData, actionData }: Route.ComponentProps) {
  const { runs } = loaderData;
  const navigation = useNavigation();
  const uploading = navigation.state === "submitting";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-[16px] font-bold text-primary-950">
          📚 Bulk Statement Import <Badge title="Still finding its feet">Beta</Badge>
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Point at a folder of PDF statements and leave it. Each one is read, matched to an
          account — created from the statement when there isn't one yet — checked against
          the register, and everything the books are missing is added and categorized.
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}

      <Card>
        <CardHeader title="Choose a folder" />
        <Form method="post" encType="multipart/form-data" className="space-y-3 p-4">
          <input
            type="file"
            name="files"
            multiple
            // Not a standard attribute in React's typings, but the whole point
            // of this screen: it turns the file picker into a folder picker.
            {...{ webkitdirectory: "", directory: "" }}
            required
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-800 hover:file:bg-primary-200"
          />
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-[12px] text-gray-700">
              <input type="checkbox" name="autoCreate" defaultChecked value="on" />
              Create accounts for statements that don't match one
            </label>
            <label className="flex items-center gap-2 text-[12px] text-gray-700">
              <input type="checkbox" name="autoCommit" defaultChecked value="on" />
              Commit each statement once the whole folder has been read
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={uploading}>
              {uploading ? "Uploading…" : "Start run"}
            </Button>
            <span className="text-xs text-gray-500">
              Nothing is read until the next screen, so a big folder uploads quickly.
            </span>
          </div>
          <p className="text-xs text-gray-500">
            Anything in the folder that isn't a PDF is skipped and listed. A statement
            whose figures don't add up to the balances printed on it is held back for you
            to look at rather than committed.{" "}
            <Link to="/reconcile" className="font-medium text-primary-600 hover:underline">
              To close a single month instead, use Monthly Reconcile →
            </Link>
          </p>
        </Form>
      </Card>

      <Card>
        <CardHeader title="Past runs" />
        {runs.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No folder has been imported yet" />
          </div>
        ) : (
          <ul className="divide-y divide-primary-50">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    r.status === "committed"
                      ? "bg-positive/15 text-positive"
                      : r.status === "discarded"
                        ? "bg-gray-200 text-gray-500"
                        : "bg-class-living/15 text-class-living"
                  }`}
                >
                  {r.status === "open" ? "in progress" : r.status}
                </span>
                <div className="flex-1">
                  <p className="font-medium text-gray-900">
                    {r.files} statement{r.files === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-gray-500">
                    {new Date((r.committedAt ?? r.createdAt) * 1000).toLocaleString()}
                  </p>
                </div>
                <Link
                  to={`/import/bulk/${r.id}`}
                  className="text-xs font-medium text-primary-600 hover:underline"
                >
                  {r.status === "open" ? "Continue →" : "View →"}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
