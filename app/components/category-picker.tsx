import { useFetcher } from "react-router";
import type { Category, SpendingClass } from "~/db/schema";
import { CLASS_LABELS } from "~/components/ui";

const CLASS_ORDER: SpendingClass[] = [
  "base",
  "living",
  "luxury",
  "income",
  "transfer",
];

export function CategoryOptions({ categories }: { categories: Category[] }) {
  return (
    <>
      {CLASS_ORDER.map((cls) => {
        const group = categories.filter((c) => c.spendingClass === cls);
        if (group.length === 0) return null;
        return (
          <optgroup key={cls} label={CLASS_LABELS[cls]}>
            {group.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/**
 * Inline category select that posts { intent: "set-category", id, categoryId }
 * to the given action (defaults to the current route).
 */
export function CategoryPicker({
  transactionId,
  categoryId,
  categories,
  action,
}: {
  transactionId: number;
  categoryId: number | null;
  categories: Category[];
  action?: string;
}) {
  const fetcher = useFetcher();
  const optimistic = fetcher.formData
    ? String(fetcher.formData.get("categoryId") ?? "")
    : null;
  const value = optimistic ?? String(categoryId ?? "");

  return (
    <fetcher.Form method="post" action={action}>
      <input type="hidden" name="intent" value="set-category" />
      <input type="hidden" name="id" value={transactionId} />
      <select
        name="categoryId"
        value={value}
        onChange={(e) => fetcher.submit(e.currentTarget.form)}
        className={`field-inset max-w-40 truncate px-1.5 py-[3px] text-[11px] ${
          value === "" ? "bg-[#fff7dd] font-bold text-class-living" : "text-gray-800"
        }`}
      >
        <option value="">Uncategorized</option>
        <CategoryOptions categories={categories} />
      </select>
    </fetcher.Form>
  );
}
