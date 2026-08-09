import { Form, data, useFetcher, useNavigation } from "react-router";
import {
  clearDatabase,
  createBackup,
  deleteBackup,
  importBackupFile,
  listBackups,
  restoreBackup,
} from "~/.server/backups";
import { importRules, parseRulesFile } from "~/.server/rules";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  fileInputClass,
  inputClass,
} from "~/components/ui";
import type { Route } from "./+types/backups";

export function meta() {
  return [{ title: "Backups & Restore · Sprout Account — Household Ledger" }];
}

export async function loader(_: Route.LoaderArgs) {
  return { backups: listBackups() };
}

/** A rules file is names and counts — anything this big isn't one. */
const RULES_MAX_BYTES = 8 * 1024 * 1024;

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

  if (intent === "import-rules") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return data({ error: "Choose a rules .json file to load." }, { status: 400 });
    }
    if (file.size > RULES_MAX_BYTES) {
      return data(
        { error: "That rules file is unexpectedly large (over 8 MB)." },
        { status: 400 },
      );
    }
    const parsed = parseRulesFile(await file.text());
    if ("error" in parsed) return data({ error: parsed.error }, { status: 400 });

    const mode = form.get("mode") === "replace" ? "replace" : "merge";
    const r = await importRules(parsed, mode);
    const parts = [
      `${r.categoriesCreated} new ${r.categoriesCreated === 1 ? "category" : "categories"} (${r.categoriesMatched} already on file)`,
      `${r.memoryAdded} merchant rules added`,
      `${r.memoryUpdated} updated`,
      `${r.memoryUnchanged} unchanged`,
    ];
    if (r.memoryKeptUser > 0) {
      parts.push(`${r.memoryKeptUser} kept (your own choice beat the file's)`);
    }
    if (r.memoryRemoved > 0) parts.push(`${r.memoryRemoved} replaced`);
    return {
      message: `Rules loaded: ${parts.join(", ")}.`,
      warning: r.normalizerWarning,
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
        <h1 className="text-[16px] font-bold text-primary-950">💾 Backups & Restore</h1>
        <p className="text-[12px] text-gray-600">
          Backups of your ledger, kept as plain SQLite files in{" "}
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
      {actionData && "warning" in actionData && actionData.warning && (
        <p className="groove bg-[#fff8e6] px-3 py-1.5 text-[12px] text-primary-900">
          {actionData.warning}
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
              className={`${fileInputClass} min-w-0 flex-1`}
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
        <CardHeader title="Categorization rules" />
        <div className="space-y-4 p-4">
          <p className="text-sm text-gray-600">
            Your categories and merchant rules — what the app has learned about
            which merchant belongs in which category — saved on their own, apart
            from accounts and transactions. Keep this file before clearing the
            database and you can start fresh without teaching it everything
            again.
          </p>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <p className="text-[12px] font-bold text-primary-950">Save rules to a file</p>
              <p className="text-xs text-gray-500">
                Downloads a .json file of every category and merchant rule.
              </p>
            </div>
            {/*
              A plain link, not a form: the response *is* the file. `Button`
              renders a real <button> and an <a> may not contain one, so the
              anchor wears the bevel classes itself.
            */}
            <a
              href="/api/rules/export"
              download
              className="bevel-btn inline-flex shrink-0 items-center justify-center gap-1.5 px-4 py-[5px] text-[12px] text-black no-underline"
            >
              Save rules
            </a>
          </div>

          <div className="groove bg-ledger p-3">
            <p className="mb-2 text-[12px] font-bold text-primary-950">Load rules from a file</p>
            <Form
              method="post"
              encType="multipart/form-data"
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="intent" value="import-rules" />
              <input
                type="file"
                name="file"
                accept=".json,application/json"
                required
                className={`${fileInputClass} min-w-0 flex-1`}
              />
              <Field label="If a merchant is already on file">
                <select name="mode" defaultValue="merge" className={inputClass}>
                  <option value="merge">Keep my rules, add the rest</option>
                  <option value="replace">Replace all merchant rules</option>
                </select>
              </Field>
              <Button type="submit" variant="secondary" disabled={busy}>
                Load rules
              </Button>
            </Form>
            <p className="mt-2 text-xs text-gray-500">
              Categories are only ever added — a category you already have keeps
              its own spending class, and nothing is deleted. Replace clears the
              merchant rules first, so the file becomes the whole list.
            </p>
          </div>
        </div>
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
