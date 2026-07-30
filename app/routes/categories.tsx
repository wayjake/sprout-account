import { Form, useFetcher } from "react-router";
import { data } from "react-router";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import {
  Button,
  Card,
  CardHeader,
  ClassBadge,
  CLASS_LABELS,
  Field,
  inputClass,
  selectClass,
} from "~/components/ui";
import { SPENDING_CLASSES, type SpendingClass } from "~/db/schema";
import type { Route } from "./+types/categories";

export function meta() {
  return [{ title: "Categories · Sprout Account — Household Ledger" }];
}

export async function loader(_: Route.LoaderArgs) {
  const categories = await db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      spendingClass: schema.categories.spendingClass,
      isArchived: schema.categories.isArchived,
      sortOrder: schema.categories.sortOrder,
      transactionCount: sql<number>`(
        select count(*) from transactions t where t.category_id = ${schema.categories.id}
      )`,
    })
    .from(schema.categories)
    .orderBy(schema.categories.sortOrder, schema.categories.name);
  return { categories };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "add") {
    const name = String(form.get("name") ?? "").trim();
    const spendingClass = String(form.get("spendingClass")) as SpendingClass;
    if (!name || !SPENDING_CLASSES.includes(spendingClass)) {
      return data({ error: "Name and class are required" }, { status: 400 });
    }
    await db
      .insert(schema.categories)
      .values({ name, spendingClass })
      .onConflictDoNothing();
    return { ok: true };
  }

  if (intent === "set-class") {
    const id = Number(form.get("id"));
    const spendingClass = String(form.get("spendingClass")) as SpendingClass;
    if (!SPENDING_CLASSES.includes(spendingClass)) {
      return data({ error: "Invalid class" }, { status: 400 });
    }
    await db
      .update(schema.categories)
      .set({ spendingClass })
      .where(eq(schema.categories.id, id));
    return { ok: true };
  }

  if (intent === "toggle-archived") {
    const id = Number(form.get("id"));
    const isArchived = form.get("isArchived") === "true";
    await db
      .update(schema.categories)
      .set({ isArchived })
      .where(eq(schema.categories.id, id));
    return { ok: true };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

export default function Categories({ loaderData, actionData }: Route.ComponentProps) {
  const { categories } = loaderData;
  const fetcher = useFetcher();
  const active = categories.filter((c) => !c.isArchived);
  const archived = categories.filter((c) => c.isArchived);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-[16px] font-bold text-primary-950">🏷️ Categories</h1>
        <p className="mt-1 text-sm text-gray-500">
          Every category belongs to a spending class:{" "}
          <span className="font-medium text-class-base">base</span> (the fixed
          foundation — mortgage, utilities),{" "}
          <span className="font-medium text-class-living">living</span> (day-to-day
          needs), and <span className="font-medium text-class-luxury">luxury</span>{" "}
          (discretionary). Income and transfers stay out of spending reports.
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}

      <Card>
        <CardHeader title="Active categories" />
        <ul className="divide-y divide-primary-50 px-4">
          {active.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="flex-1 font-medium text-gray-900">{c.name}</span>
              <span className="text-xs text-gray-400">
                {c.transactionCount} transaction{c.transactionCount === 1 ? "" : "s"}
              </span>
              <ClassBadge spendingClass={c.spendingClass} />
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="set-class" />
                <input type="hidden" name="id" value={c.id} />
                <select
                  name="spendingClass"
                  defaultValue={c.spendingClass}
                  className={selectClass}
                  onChange={(e) => fetcher.submit(e.currentTarget.form)}
                >
                  {SPENDING_CLASSES.map((s) => (
                    <option key={s} value={s}>
                      {CLASS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </fetcher.Form>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="toggle-archived" />
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="isArchived" value="true" />
                <Button variant="ghost" size="sm" type="submit">
                  Archive
                </Button>
              </fetcher.Form>
            </li>
          ))}
        </ul>
        <div className="border-t border-primary-100 p-4">
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="add" />
            <div className="flex-1">
              <Field label="New category">
                <input name="name" placeholder="Pets" className={inputClass} required />
              </Field>
            </div>
            <Field label="Class">
              <select name="spendingClass" className={selectClass}>
                {SPENDING_CLASSES.map((s) => (
                  <option key={s} value={s}>
                    {CLASS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="secondary">
              Add
            </Button>
          </Form>
        </div>
      </Card>

      {archived.length > 0 && (
        <Card>
          <CardHeader title="Archived" />
          <ul className="divide-y divide-primary-50 px-4">
            {archived.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2.5 text-sm text-gray-500">
                <span className="flex-1">{c.name}</span>
                <ClassBadge spendingClass={c.spendingClass} />
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="toggle-archived" />
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="isArchived" value="false" />
                  <Button variant="ghost" size="sm" type="submit">
                    Restore
                  </Button>
                </fetcher.Form>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
