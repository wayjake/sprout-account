import { Form, data, useFetcher, useNavigation } from "react-router";
import {
  clearDatabase,
  createBackup,
  deleteBackup,
  importBackupFile,
  listBackups,
  restoreBackup,
} from "~/.server/backups";
import { Button, Card, CardHeader, EmptyState, Field, inputClass } from "~/components/ui";
import type { Route } from "./+types/backups";

export function meta() {
  return [{ title: "The Time Vault · Sprout Account 2000" }];
}

export async function loader(_: Route.LoaderArgs) {
  return { backups: listBackups() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const filename = await createBackup(String(form.get("label") ?? ""));
    return { message: `Backup created: ${filename}` };
  }

  if (intent === "restore") {
    const filename = String(form.get("filename") ?? "");
    if (form.get("confirm") !== "restore") {
      return data(
        { error: 'Type "restore" to confirm — this replaces your current data.' },
        { status: 400 },
      );
    }
    const error = await restoreBackup(filename);
    if (error) return data({ error }, { status: 400 });
    return {
      message: `Restored ${filename}. Your previous data was saved as a "pre-restore" backup.`,
    };
  }

  if (intent === "delete") {
    const error = deleteBackup(String(form.get("filename") ?? ""));
    if (error) return data({ error }, { status: 400 });
    return { message: "Backup deleted." };
  }

  if (intent === "import") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return data({ error: "Choose a .db file to import." }, { status: 400 });
    }
    const result = importBackupFile(
      Buffer.from(await file.arrayBuffer()),
      file.name,
    );
    if ("error" in result) return data({ error: result.error }, { status: 400 });
    return {
      message: `Imported as ${result.filename} — restore it below to make it the live database.`,
    };
  }

  if (intent === "reset") {
    if (form.get("confirm") !== "reset") {
      return data(
        { error: 'Type "reset" to confirm — this clears all data.' },
        { status: 400 },
      );
    }
    await clearDatabase();
    return {
      message:
        'Database cleared — fresh start with starter categories. Your previous data was saved as a "pre-reset" backup.',
    };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function Backups({ loaderData, actionData }: Route.ComponentProps) {
  const { backups } = loaderData;
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-[16px] font-bold text-primary-950">💾 The Time Vault</h1>
        <p className="text-[12px] text-gray-600">
          Snapshots of your saga, kept as plain SQLite files in{" "}
          <code>data/backups/</code> (named <code>timestamp__label.db</code>).
          Restoring swaps the live ledger — and always stashes your current one first.
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}
      {actionData && "message" in actionData && (
        <p className="groove bg-[#eef7ee] px-3 py-1.5 text-[12px] text-primary-900">
          {actionData.message}
        </p>
      )}

      <div className="grid grid-cols-2 gap-5">
        <Card>
          <CardHeader title="Create a backup" />
          <Form method="post" className="flex items-end gap-2 p-4">
            <input type="hidden" name="intent" value="create" />
            <div className="flex-1">
              <Field label="Label (optional)">
                <input name="label" placeholder="before-big-import" className={inputClass} />
              </Field>
            </div>
            <Button type="submit" disabled={busy}>
              Back up now
            </Button>
          </Form>
        </Card>

        <Card>
          <CardHeader title="Load an external .db file" />
          <Form method="post" encType="multipart/form-data" className="flex items-end gap-2 p-4">
            <input type="hidden" name="intent" value="import" />
            <input
              type="file"
              name="file"
              accept=".db,application/x-sqlite3"
              required
              className="block flex-1 text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-800 hover:file:bg-primary-200"
            />
            <Button type="submit" variant="secondary" disabled={busy}>
              Add to backups
            </Button>
          </Form>
        </Card>
      </div>

      <Card>
        <CardHeader title={`Saved backups (${backups.length})`} />
        {backups.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No backups yet"
              detail="Create one above — restores and resets also save one automatically."
            />
          </div>
        ) : (
          <ul className="divide-y divide-primary-50">
            {backups.map((b) => (
              <li key={b.filename} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="flex-1">
                  <p className="font-medium text-gray-900">{b.label}</p>
                  <p className="text-xs text-gray-500">
                    {b.createdAt} · {formatSize(b.sizeBytes)} · {b.filename}
                  </p>
                </div>
                <Form method="post" className="flex items-center gap-1.5">
                  <input type="hidden" name="intent" value="restore" />
                  <input type="hidden" name="filename" value={b.filename} />
                  <input
                    name="confirm"
                    placeholder='type "restore"'
                    className="w-28 rounded-md border border-primary-200 px-2 py-1 text-xs"
                    autoComplete="off"
                  />
                  <Button size="sm" variant="secondary" type="submit" disabled={busy}>
                    Restore
                  </Button>
                </Form>
                <fetcher.Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(`Delete backup ${b.filename}?`)) e.preventDefault();
                  }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="filename" value={b.filename} />
                  <Button size="sm" variant="ghost" type="submit">
                    Delete
                  </Button>
                </fetcher.Form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="☠️ The Forbidden Lever (danger zone)" />
        <div className="bg-ledger p-4">
          <p className="mb-3 text-sm text-gray-600">
            Clear the database to start fresh: removes all accounts, transactions,
            imports, Amazon data, and merchant memory, then reseeds the starter
            categories. A backup of the current data is saved automatically first.
          </p>
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="reset" />
            <input
              name="confirm"
              placeholder='type "reset" to confirm'
              className={`${inputClass} w-52`}
              autoComplete="off"
            />
            <Button variant="danger" type="submit" disabled={busy}>
              Clear database
            </Button>
          </Form>
        </div>
      </Card>
    </div>
  );
}
