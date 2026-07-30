import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { chatJSON } from "~/.server/openrouter";
import {
  heuristicMapping,
  MappingSchema,
  type Mapping,
} from "~/lib/csv-mapping";

export async function findSavedMapping(
  accountId: number,
  signature: string,
): Promise<Mapping | null> {
  const [row] = await db
    .select()
    .from(schema.csvMappings)
    .where(
      and(
        eq(schema.csvMappings.accountId, accountId),
        eq(schema.csvMappings.headerSignature, signature),
      ),
    )
    .limit(1);
  if (!row) return null;
  const parsed = MappingSchema.safeParse(JSON.parse(row.mappingJson));
  if (!parsed.success) return null;
  await db
    .update(schema.csvMappings)
    .set({ lastUsedAt: sql`(unixepoch())` })
    .where(eq(schema.csvMappings.id, row.id));
  return parsed.data;
}

export async function saveMapping(
  accountId: number,
  signature: string,
  mapping: Mapping,
) {
  await db
    .insert(schema.csvMappings)
    .values({
      accountId,
      headerSignature: signature,
      mappingJson: JSON.stringify(mapping),
      lastUsedAt: sql`(unixepoch())`,
    })
    .onConflictDoUpdate({
      target: [schema.csvMappings.accountId, schema.csvMappings.headerSignature],
      set: {
        mappingJson: JSON.stringify(mapping),
        lastUsedAt: sql`(unixepoch())`,
      },
    });
}

/**
 * Ask the AI to suggest a column mapping. Falls back to a header-name
 * heuristic when the API key is missing or the call fails.
 */
export async function suggestMapping(
  headers: string[],
  sampleRows: Record<string, string>[],
  kind: "transactions" | "balances",
): Promise<{ mapping: Mapping; source: "ai" | "heuristic" }> {
  const fallback = heuristicMapping(headers, sampleRows, kind);
  if (!process.env.OPENROUTER_API_KEY) {
    return { mapping: fallback, source: "heuristic" };
  }
  try {
    const sample = sampleRows
      .slice(0, 15)
      .map((r) => headers.map((h) => r[h] ?? "").join(" , "))
      .join("\n");
    const mapping = await chatJSON({
      system: `You map bank/credit-card CSV export columns to a normalized schema. Column names must exactly match the provided headers. Rules:
- ${kind === "balances" ? "This is a BALANCE history export (investment account): identify the date column and the balance/value column. Set amountStyle, amountColumn, debitColumn, creditColumn to null and descriptionColumns to []." : "This is a TRANSACTION export: identify date, description column(s), and how amounts are represented."}
- amountStyle "single_signed": one amount column where spending is negative.
- amountStyle "single_inverted": one amount column where spending/charges are positive (common for credit cards).
- amountStyle "debit_credit": separate debit (spending) and credit (inflow) columns.
- Prefer the posted/settled date column over authorization date when both exist.
- Unused string fields must be null (or [] for descriptionColumns).`,
      user: `Headers: ${JSON.stringify(headers)}\n\nFirst rows (comma-separated in header order):\n${sample}`,
      schema: MappingSchema,
      schemaName: "csv_mapping",
    });
    return { mapping, source: "ai" };
  } catch {
    return { mapping: fallback, source: "heuristic" };
  }
}
