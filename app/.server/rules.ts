import { sql } from "drizzle-orm";
import crypto from "node:crypto";
import { z } from "zod";
import { normalizeMerchant } from "~/.server/categorize";
import { db, schema } from "~/.server/db";
import { SPENDING_CLASSES } from "~/db/schema";

/**
 * Categorization rules — categories plus merchant memory — exported and
 * imported on their own, apart from the database they came out of.
 *
 * The point is the asymmetry between the two kinds of data this app holds.
 * Accounts and transactions are a record of one household's money and belong
 * to the file they live in. The rules are the *work*: hundreds of small
 * judgements about which merchant is which category, built up import by
 * import. Clearing the database to start over shouldn't throw that away, so
 * the rules travel in a file of their own.
 *
 * Everything is keyed by **name**, never by id. Row ids do not survive a
 * `clearDatabase()`, and a rules file is expected to be imported into a
 * database that has never seen the one it was exported from.
 */

const FORMAT = "sprout-account-rules";
const VERSION = 1;

/**
 * The merchant keys in an export are the output of `normalizeMerchant` as it
 * existed when the file was written. Change that function and the same
 * descriptions normalize differently — every rule in an older file would then
 * sit in the table matching nothing, silently, forever (CLAUDE.md: changing
 * `normalizeMerchant` means re-keying existing rows).
 *
 * So each export carries a fingerprint: a hash of these probes run through the
 * current normalizer. The probes are chosen to touch each branch that shapes a
 * key — processor prefixes, the Amazon collapse, reference-code and store-number
 * stripping, the trailing city/state pair, and the length cap. A mismatch on
 * import is a warning rather than a refusal: the rules are still the user's
 * judgements, they may just need re-keying by hand.
 *
 * Do not edit this list. Adding a probe changes every fingerprint and would
 * make files exported by older builds look stale when they aren't.
 */
const NORMALIZER_PROBES = [
  "SQ *COFFEE SHOP 1234 PORTLAND OR",
  "TST* THE DINER #0042",
  "AMZN Mktp US*2B4XY9",
  "AMAZON PRIME*MEMBERSHIP",
  "PURCHASE AUTHORIZED ON 06/16 WHOLE FOODS XXXX4321",
  "ACH DEBIT DUBSADO LLC BUSINESS CHECKING JUNE SHAREHOLDER DIVIDENDS 6Seml5S77Ug",
  "CHECKCARD 0612 SHELL OIL Ref #lb0Yntnk3L",
  "PAYPAL *STEAMGAMES.COM",
];

export function merchantKeyFingerprint(): string {
  const keys = NORMALIZER_PROBES.map((p) => normalizeMerchant(p)).join("\n");
  return crypto.createHash("sha256").update(keys).digest("hex").slice(0, 16);
}

/**
 * The on-disk shape. A named-section object rather than a bare array so a
 * later section (CSV column mappings, say) can be added without a format
 * break: an older reader ignores what it doesn't know, and a newer reader
 * treats a missing section as empty.
 */
const rulesFileSchema = z.object({
  format: z.literal(FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.string().optional(),
  merchantKeyFingerprint: z.string().optional(),
  categories: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        spendingClass: z.enum(SPENDING_CLASSES),
        isArchived: z.boolean().default(false),
        sortOrder: z.number().int().default(0),
      }),
    )
    .default([]),
  merchantMemory: z
    .array(
      z.object({
        merchant: z.string().min(1).max(200),
        category: z.string().min(1).max(120),
        source: z.enum(["user", "ai"]),
        useCount: z.number().int().min(1).max(1_000_000).default(1),
      }),
    )
    .default([]),
});

export type RulesFile = z.infer<typeof rulesFileSchema>;

export async function exportRules(): Promise<RulesFile> {
  const [categories, memory] = await Promise.all([
    db.select().from(schema.categories),
    db.select().from(schema.merchantMemory),
  ]);
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    merchantKeyFingerprint: merchantKeyFingerprint(),
    categories: categories
      .map((c) => ({
        name: c.name,
        spendingClass: c.spendingClass,
        isArchived: c.isArchived,
        sortOrder: c.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    merchantMemory: memory
      // A memory row whose category is gone can't be re-pointed on the far
      // side, so it isn't worth exporting. `categoryId` is notNull with an FK,
      // so this only drops rows in a database that has lost referential
      // integrity some other way.
      .flatMap((m) => {
        const category = nameById.get(m.categoryId);
        if (!category) return [];
        return [
          {
            merchant: m.normalizedMerchant,
            category,
            source: m.source,
            useCount: m.useCount,
          },
        ];
      })
      .sort((a, b) => a.merchant.localeCompare(b.merchant)),
  };
}

export function rulesFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `sprout-rules_${stamp}.json`;
}

export type ImportMode = "merge" | "replace";

export interface RulesImportResult {
  categoriesCreated: number;
  categoriesMatched: number;
  memoryAdded: number;
  memoryUpdated: number;
  memoryUnchanged: number;
  /** Incoming `ai` rows that lost to an existing `user` row. */
  memoryKeptUser: number;
  memoryRemoved: number;
  /** Set when the file was written by a build with a different merchant key. */
  normalizerWarning: string | null;
}

/** Multi-row insert chunk — keeps the bound-parameter count well under SQLite's cap. */
const CHUNK = 150;

function chunked<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

export function parseRulesFile(text: string): RulesFile | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "That file isn't valid JSON." };
  }
  const parsed = rulesFileSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "file";
    return {
      error:
        json && typeof json === "object" && (json as { format?: unknown }).format !== FORMAT
          ? "That isn't a Sprout Account rules file. Export one from Backups & Restore."
          : `Rules file is malformed (${where}: ${first?.message ?? "unknown"}).`,
    };
  }
  if (parsed.data.version > VERSION) {
    return {
      error: `That file was written by a newer version of Sprout Account (format ${parsed.data.version}).`,
    };
  }
  return parsed.data;
}

/**
 * Load a rules file into the live database.
 *
 * **Categories are always merged, never replaced.** A name that already exists
 * is reused as-is — the local `spendingClass` and sort order win, because
 * quietly reclassifying Groceries from living to luxury on the strength of an
 * imported file is not what "import my rules" means. A name that is absent is
 * created from the file. Categories are never deleted either: a rules import
 * shouldn't be able to orphan `transactions.categoryId` on a database that
 * turns out not to have been empty.
 *
 * **Merchant memory is where `mode` bites.** `merge` layers the file over what
 * is there using the same precedence the app applies while it runs
 * (`recordUserChoice` / `recordAiChoice`): a `user` row wins over an `ai` row,
 * and an incoming `ai` row never overwrites a local `user` one. `replace`
 * clears memory first, so the file is exactly what's left.
 *
 * `useCount` resolves to the larger of the two rather than the sum, and rows
 * that would resolve to what's already stored are skipped entirely — so
 * importing the same file twice is a no-op rather than a slow way to inflate
 * every counter.
 */
export async function importRules(
  file: RulesFile,
  mode: ImportMode,
): Promise<RulesImportResult> {
  const result: RulesImportResult = {
    categoriesCreated: 0,
    categoriesMatched: 0,
    memoryAdded: 0,
    memoryUpdated: 0,
    memoryUnchanged: 0,
    memoryKeptUser: 0,
    memoryRemoved: 0,
    normalizerWarning:
      file.merchantKeyFingerprint && file.merchantKeyFingerprint !== merchantKeyFingerprint()
        ? "This file was exported by a build whose merchant keys are built differently. " +
          "The rules were loaded, but some may no longer match anything until they are re-saved from a transaction."
        : null,
  };

  await db.transaction(async (tx) => {
    // ---- Categories: match on name, create what's missing -------------------
    const existingCategories = await tx.select().from(schema.categories);
    const idByName = new Map(
      existingCategories.map((c) => [c.name.toLowerCase(), c.id]),
    );

    // Collapse the file's own list first — `categories.name` is unique, so two
    // entries for "Groceries" (a hand-edited file, two exports concatenated)
    // would land in the same multi-row insert and abort the whole import. The
    // key is lowercased to match the lookup below: a local "Groceries" should
    // absorb a file's "groceries" rather than spawn a near-twin.
    const incomingCategories = [
      ...new Map(file.categories.map((c) => [c.name.toLowerCase(), c])).values(),
    ];
    const missing = incomingCategories.filter((c) => !idByName.has(c.name.toLowerCase()));
    result.categoriesMatched = incomingCategories.length - missing.length;

    for (const batch of chunked(missing)) {
      const inserted = await tx
        .insert(schema.categories)
        .values(
          batch.map((c) => ({
            name: c.name,
            spendingClass: c.spendingClass,
            isArchived: c.isArchived,
            sortOrder: c.sortOrder,
          })),
        )
        .returning({ id: schema.categories.id, name: schema.categories.name });
      for (const row of inserted) idByName.set(row.name.toLowerCase(), row.id);
      result.categoriesCreated += inserted.length;
    }

    // ---- Merchant memory ----------------------------------------------------
    if (mode === "replace") {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.merchantMemory);
      result.memoryRemoved = count;
      await tx.delete(schema.merchantMemory).run();
    }

    const existingMemory =
      mode === "replace" ? [] : await tx.select().from(schema.merchantMemory);
    const byMerchant = new Map(existingMemory.map((m) => [m.normalizedMerchant, m]));

    const toWrite: {
      normalizedMerchant: string;
      categoryId: number;
      source: "user" | "ai";
      useCount: number;
    }[] = [];
    // The file's own keys are unique in practice, but nothing enforces it — a
    // duplicate inside one multi-row insert would trip the unique index and
    // roll the whole import back. Collapse to last-one-wins before counting,
    // so the tally matches what is actually written.
    const incoming = [
      ...new Map(file.merchantMemory.map((r) => [r.merchant, r])).values(),
    ];

    for (const row of incoming) {
      const categoryId = idByName.get(row.category.toLowerCase());
      // A memory row naming a category the file never listed. Skipping is the
      // conservative read: inventing a category from a name alone would guess
      // at its spending class.
      if (categoryId === undefined) continue;

      const existing = byMerchant.get(row.merchant);
      if (existing) {
        if (existing.source === "user" && row.source === "ai") {
          result.memoryKeptUser++;
          continue;
        }
        const useCount = Math.max(existing.useCount, row.useCount);
        if (
          existing.categoryId === categoryId &&
          existing.source === row.source &&
          existing.useCount === useCount
        ) {
          result.memoryUnchanged++;
          continue;
        }
        result.memoryUpdated++;
        toWrite.push({
          normalizedMerchant: row.merchant,
          categoryId,
          source: row.source,
          useCount,
        });
      } else {
        result.memoryAdded++;
        toWrite.push({
          normalizedMerchant: row.merchant,
          categoryId,
          source: row.source,
          useCount: row.useCount,
        });
      }
    }

    // One statement per chunk, not one per row: under Turso every write is a
    // synchronous round trip to the primary, and memory runs to thousands of
    // rows. Precedence was already settled above, so the upsert here is
    // unconditional.
    for (const batch of chunked(toWrite)) {
      await tx
        .insert(schema.merchantMemory)
        .values(batch)
        .onConflictDoUpdate({
          target: schema.merchantMemory.normalizedMerchant,
          set: {
            categoryId: sql`excluded.category_id`,
            source: sql`excluded.source`,
            useCount: sql`excluded.use_count`,
            updatedAt: sql`(unixepoch())`,
          },
        })
        .run();
    }
  });

  return result;
}
