import { Form, useFetcher } from "react-router";
import { data } from "react-router";
import { eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import {
  Button,
  Card,
  CardHeader,
  Field,
  inputClass,
  selectClass,
} from "~/components/ui";
import { ACCOUNT_TYPES, type AccountType } from "~/db/schema";
import type { Route } from "./+types/accounts";

export function meta() {
  return [{ title: "The Workshop · Sprout Account 2000" }];
}

export async function loader(_: Route.LoaderArgs) {
  const accounts = await db
    .select()
    .from(schema.accounts)
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);
  return { accounts };
}

const TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  investment: "Investment",
  retirement: "Retirement",
  other: "Other",
};

function kindForType(accountType: AccountType) {
  return accountType === "investment" || accountType === "retirement"
    ? ("balance" as const)
    : ("transaction" as const);
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "add-account") {
    const name = String(form.get("name") ?? "").trim();
    const institution = String(form.get("institution") ?? "").trim();
    const accountType = String(form.get("accountType")) as AccountType;
    const lastFour = String(form.get("lastFour") ?? "").trim() || null;
    if (!name || !institution || !ACCOUNT_TYPES.includes(accountType)) {
      return data({ error: "Name, institution, and type are required" }, { status: 400 });
    }
    await db.insert(schema.accounts).values({
      name,
      institution,
      accountType,
      kind: kindForType(accountType),
      lastFour,
    });
    return { ok: true };
  }

  if (intent === "toggle-account") {
    const id = Number(form.get("id"));
    const isActive = form.get("isActive") === "true";
    await db
      .update(schema.accounts)
      .set({ isActive })
      .where(eq(schema.accounts.id, id));
    return { ok: true };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

export default function Accounts({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts } = loaderData;
  const fetcher = useFetcher();

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-[16px] font-bold text-primary-950">⚙️ The Workshop</h1>
        <p className="text-[12px] text-gray-600">
          Where coin purses and treasure hoards are forged.
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}

      <Card>
        <CardHeader title="Accounts" />
        <div className="bg-ledger p-4">
          <ul className="mb-5 space-y-1.5">
            {accounts.map((a) => (
              <li
                key={a.id}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                  a.isActive ? "bg-primary-50" : "bg-gray-100 opacity-60"
                }`}
              >
                <div className="flex-1">
                  <p className="font-medium text-primary-900">
                    {a.name}
                    {a.lastFour && (
                      <span className="ml-1.5 text-xs text-gray-500">··{a.lastFour}</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    {a.institution} · {TYPE_LABELS[a.accountType]}
                  </p>
                </div>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="toggle-account" />
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="isActive" value={String(!a.isActive)} />
                  <Button variant="ghost" size="sm" type="submit">
                    {a.isActive ? "Archive" : "Restore"}
                  </Button>
                </fetcher.Form>
              </li>
            ))}
          </ul>

          <Form method="post" className="grid grid-cols-2 gap-3">
            <input type="hidden" name="intent" value="add-account" />
            <Field label="Account name">
              <input name="name" placeholder="Household Checking" className={inputClass} required />
            </Field>
            <Field label="Institution">
              <input name="institution" placeholder="Chase" className={inputClass} required />
            </Field>
            <Field label="Type">
              <select name="accountType" className={`${selectClass} w-full`}>
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Last four digits (optional)">
              <input name="lastFour" placeholder="1234" maxLength={4} className={inputClass} />
            </Field>
            <div className="col-span-2 flex justify-end">
              <Button type="submit">Add account</Button>
            </div>
          </Form>
          <p className="mt-3 text-xs text-gray-500">
            Investment and retirement accounts track balance snapshots from statements;
            all other types track individual transactions.
          </p>
        </div>
      </Card>
    </div>
  );
}
