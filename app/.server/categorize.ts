import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "~/.server/db";
import { chatJSON } from "~/.server/openrouter";
import {
  autoLinkAccountTransfers,
  linkTransferToAccount,
  looksLikeTransfer,
} from "~/.server/transfers";
import { ACCOUNT_TYPE_LABELS, isLiability, paymentCategoryName } from "~/lib/accounts";

/**
 * How much of a description survives into the merchant key. Long enough to keep
 * the memo a bank tacks onto a transfer — "…BUSINESS CHECKING JUNE SHAREHOLDER
 * DIVIDENDS" vs "…BUSINESS CHECKING Q2 PERSONAL TAX PAYMENTS" only diverge past
 * char 50, and they are different categories. Reference codes are stripped
 * above, so a longer key stays stable rather than becoming per-transaction.
 */
const MERCHANT_KEY_MAX = 80;

/**
 * Normalize a raw statement description into a stable merchant key.
 * Pure function — used for merchant memory lookup.
 */
export function normalizeMerchant(description: string): string {
  let s = description.toUpperCase().trim();

  // Processor / channel prefixes
  const prefixes = [
    /^SQ \*/,
    /^TST\*\s?/,
    /^PAYPAL \*/,
    /^PP\*\s?/,
    /^PY \*/,
    /^SP\s+/,
    /^POS DEBIT\s+/,
    /^POS PURCHASE\s+/,
    /^DEBIT CARD PURCHASE\s+/,
    /^CHECKCARD\s+\d*\s*/,
    /^PURCHASE AUTHORIZED ON \d{2}\/\d{2}\s+/,
    /^ACH (DEBIT|CREDIT|WEBSINGLE|PMT)\s+/,
    /^RECURRING PAYMENT\s+/,
    /^WEB PMT[- ]/,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of prefixes) {
      if (re.test(s)) {
        s = s.replace(re, "");
        changed = true;
      }
    }
  }

  // Amazon variants collapse to one merchant
  if (/\bAMZN\b|AMAZON/.test(s)) {
    if (/PRIME/.test(s)) return "AMAZON PRIME";
    return "AMAZON";
  }

  s = s
    .replace(/#\d+/g, " ") // store numbers
    .replace(/\bX{4,}\d*\b/g, " ") // masked card numbers
    .replace(/\b\d{4,}\b/g, " ") // long reference numbers
    .replace(/\bREF\s*#?\s*[A-Z0-9]{4,}\b/g, " ") // "Ref #lb0Yntnk3L"
    .replace(/\bON \d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ") // trailing "On 06/16/26"
    // Bare per-transaction reference codes: 8+ chars mixing letters and digits
    // ("6Seml5S77Ug", "B3B0F6A2"). Without this, every payroll run and every
    // business distribution gets its own merchant key and memory never hits.
    .replace(
      /\b(?=[A-Z0-9]{8,}\b)(?=(?:[A-Z0-9]*\d){2})(?=(?:[A-Z0-9]*[A-Z]){2})[A-Z0-9]+\b/g,
      " ",
    )
    .replace(/\.(COM|NET|ORG)\b/g, " "); // domain suffixes

  // Trailing "CITY ST" pair (2-letter state code at the end)
  s = s.replace(
    /\s+[A-Z]{3,}\s+(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s*$/,
    " ",
  );

  s = s
    .replace(/[^A-Z0-9'& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MERCHANT_KEY_MAX)
    .trim();

  return s || description.toUpperCase().trim().slice(0, MERCHANT_KEY_MAX);
}

/** The category fields the liability guard needs to resolve an assignment. */
type GuardCategory = Pick<
  schema.Category,
  "id" | "name" | "spendingClass" | "isArchived"
>;

/**
 * A positive amount on a debt — card, line of credit, mortgage or loan — is
 * money coming *off* what is owed. It is a payment or a credit, and is never
 * household income.
 *
 * Transfer matching (`transfers.ts`) normally turns the payment leg into a
 * linked pair, but only when the funding account's leg was imported too.
 * Import a card statement on its own and there is nothing to pair with, so the
 * row falls through to the AI, which has categorized "AUTOPAY PAYMENT RECEIVED
 * - THANK YOU" as Salary. This is the deterministic backstop that runs before
 * both the memory and AI passes.
 *
 * Returns the category id to force, `null` to leave the row uncategorized
 * rather than let an income category stand, or `undefined` when the guard has
 * no opinion and the caller's own choice should win.
 */
export function guardLiabilityCredit(
  txn: { amountCents: number; description: string },
  accountType: schema.AccountType,
  proposedCategoryId: number | null,
  categories: GuardCategory[],
): number | null | undefined {
  if (!isLiability(accountType) || txn.amountCents <= 0) return undefined;

  const proposed =
    proposedCategoryId == null
      ? undefined
      : categories.find((c) => c.id === proposedCategoryId);
  const proposedIsIncome = proposed?.spendingClass === "income";

  if (looksLikeTransfer(txn.description)) {
    const wanted = paymentCategoryName(accountType)?.toLowerCase();
    const payment =
      categories.find(
        (c) =>
          !c.isArchived &&
          c.spendingClass === "transfer" &&
          c.name.toLowerCase() === wanted,
      ) ?? categories.find((c) => !c.isArchived && c.spendingClass === "transfer");
    if (payment) return payment.id;
    // No transfer category on file — still better uncategorized than income.
    return proposedIsIncome ? null : undefined;
  }

  // Refunds, statement credits and escrow adjustments: not a payment, but not
  // income either.
  return proposedIsIncome ? null : undefined;
}

/**
 * Record a user's manual category choice so future imports of the same
 * merchant auto-categorize. User choices always win over AI-sourced rows.
 */
export async function recordUserChoice(merchant: string, categoryId: number) {
  if (!merchant) return;
  await db
    .insert(schema.merchantMemory)
    .values({ normalizedMerchant: merchant, categoryId, source: "user" })
    .onConflictDoUpdate({
      target: schema.merchantMemory.normalizedMerchant,
      set: {
        categoryId,
        source: "user",
        useCount: sql`${schema.merchantMemory.useCount} + 1`,
        updatedAt: sql`(unixepoch())`,
      },
    });
}

/** Record an AI suggestion in memory without overwriting user-sourced rows. */
export async function recordAiChoice(merchant: string, categoryId: number) {
  if (!merchant) return;
  const existing = await db
    .select()
    .from(schema.merchantMemory)
    .where(eq(schema.merchantMemory.normalizedMerchant, merchant))
    .limit(1);
  if (existing.length > 0) {
    if (existing[0].source === "user") return;
    await db
      .update(schema.merchantMemory)
      .set({
        categoryId,
        useCount: sql`${schema.merchantMemory.useCount} + 1`,
        updatedAt: sql`(unixepoch())`,
      })
      .where(eq(schema.merchantMemory.id, existing[0].id));
  } else {
    await db
      .insert(schema.merchantMemory)
      .values({ normalizedMerchant: merchant, categoryId, source: "ai" });
  }
}

export type MemoryRow = typeof schema.merchantMemory.$inferSelect;

export async function loadMemory(): Promise<MemoryRow[]> {
  return db.select().from(schema.merchantMemory);
}

/**
 * Look up a category for a normalized merchant:
 * 1. exact match; 2. prefix match (either direction, both sides ≥ 6 chars),
 * preferring user-sourced rows, then higher useCount.
 */
/**
 * Rows per AI request. Also the chunk size the client runs a bulk
 * categorization in (`api.ai-categorize.ts`), so one chunk is one AI call —
 * which is what bounds how long a cancel takes to land.
 */
export const AI_BATCH_SIZE = 40;
const AI_CONFIDENCE_THRESHOLD = 0.6;

const AssignmentsSchema = z.object({
  assignments: z.array(
    z.object({
      id: z.number(),
      /** null when no listed category fits */
      categoryId: z.number().nullable(),
      /**
       * The balance-only account this row's money went to or came from, when
       * it is one of the listed ones. Null for everything else — which is
       * almost every row.
       */
      transferAccountId: z.number().nullable().optional(),
      confidence: z.number(),
    }),
  ),
});

export interface CategorizeStats {
  fromMemory: number;
  fromAi: number;
  fromRule: number;
  /** Legs pointed at a balance-only account, which files them as transfers. */
  accountsLinked: number;
  blocked: number;
  lowConfidence: number;
  remaining: number;
}

/**
 * Categorize the given transactions (or all uncategorized ones when ids is
 * null): far-side account links first, then the credit-card guard, then free
 * merchant memory, then AI for whatever is left.
 */
export async function categorizeTransactions(
  ids: number[] | null,
  { aiLimit = 200 }: { aiLimit?: number } = {},
): Promise<CategorizeStats> {
  const t = schema.transactions;

  // Pass 0: legs whose far side is a balance-only account. This runs ahead of
  // everything because a link decides the category itself — filing the row
  // from memory first would leave a mortgage payment sitting in a spending
  // category with nothing pointing at the mortgage.
  const accountsLinked = await autoLinkAccountTransfers(ids ?? undefined);

  const targets = await db
    .select({
      id: t.id,
      merchant: t.merchant,
      description: t.description,
      amountCents: t.amountCents,
      date: t.date,
      accountType: schema.accounts.accountType,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .where(
      ids
        ? and(inArray(t.id, ids), isNull(t.categoryId))
        : isNull(t.categoryId),
    )
    .limit(ids ? ids.length : aiLimit + 2000);

  const stats: CategorizeStats = {
    fromMemory: 0,
    fromAi: 0,
    fromRule: 0,
    accountsLinked,
    blocked: 0,
    lowConfidence: 0,
    remaining: 0,
  };
  if (targets.length === 0) return stats;

  // Archived categories are excluded from what the AI may pick, but the guard
  // still has to recognise one a memory row points at.
  const allCategories = await db.select().from(schema.categories);
  const categories = allCategories.filter((c) => !c.isArchived);

  // Pass 1: rules and merchant memory — free, no network
  const memory = await loadMemory();
  const unresolved: typeof targets = [];
  for (const txn of targets) {
    const forced = guardLiabilityCredit(txn, txn.accountType, null, allCategories);
    if (forced != null) {
      await db
        .update(t)
        .set({ categoryId: forced, categorySource: "auto" })
        .where(eq(t.id, txn.id));
      stats.fromRule++;
      continue;
    }

    const hit = lookupMemory(txn.merchant, memory);
    if (!hit) {
      unresolved.push(txn);
      continue;
    }
    // A remembered income category on a card credit is the bug this guards
    // against — leave it uncategorized rather than trust stale memory.
    if (
      guardLiabilityCredit(txn, txn.accountType, hit.categoryId, allCategories) === null
    ) {
      stats.blocked++;
      continue;
    }
    await db
      .update(t)
      .set({ categoryId: hit.categoryId, categorySource: "memory" })
      .where(eq(t.id, txn.id));
    stats.fromMemory++;
  }

  // Pass 2: AI for the rest, in batches
  const categoryIds = new Set(categories.map((c) => c.id));
  const categoryList = categories
    .map((c) => `${c.id}: ${c.name} (${c.spendingClass})`)
    .join("\n");

  // The AI cannot tell "transfer from my own savings" from "transfer from the
  // LLC I own" without knowing which accounts are actually in this ledger.
  const ownAccounts = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      institution: schema.accounts.institution,
      accountType: schema.accounts.accountType,
      kind: schema.accounts.kind,
      isActive: schema.accounts.isActive,
    })
    .from(schema.accounts);
  const ownAccountList =
    ownAccounts.map((a) => `- ${a.institution} ${a.name}`).join("\n") ||
    "- (none on file)";

  // Balance-only accounts are the ones a row can name as its far side: they
  // keep no ledger, so no opposite row will ever exist to pair with.
  const balanceAccounts = ownAccounts.filter((a) => a.kind === "balance" && a.isActive);
  const balanceAccountIds = new Set(balanceAccounts.map((a) => a.id));
  const balanceAccountList = balanceAccounts
    .map(
      (a) =>
        `${a.id}: ${a.institution} ${a.name} (${ACCOUNT_TYPE_LABELS[a.accountType].toLowerCase()})`,
    )
    .join("\n");

  const toAi = unresolved.slice(0, aiLimit);
  stats.remaining = unresolved.length - toAi.length;

  for (let i = 0; i < toAi.length; i += AI_BATCH_SIZE) {
    const batch = toAi.slice(i, i + AI_BATCH_SIZE);
    const result = await chatJSON({
      system: `You categorize household financial transactions. Assign each transaction the best-fitting category id from the list, with a confidence between 0 and 1. Use null for categoryId when nothing fits well. Amounts are integer cents; negative = spending, positive = income. Consider the merchant name primarily.

Money moved between two of the household's OWN accounts — the ones listed below, and only those — is a TRANSFER, not income or spending. Credit card payments, "PAYMENT THANK YOU", and bank-to-bank movements between those accounts must get a transfer-class category, never an income or spending one.

The word "transfer" in a description does NOT by itself make something a transfer. Money arriving from an outside party is INCOME even when the bank calls it a transfer — a distribution, dividend or draw from a business the household owns, a client payment, or a person sending money. Only treat "TRANSFER FROM/TO <name>" as a transfer when <name> is one of the household's own accounts below. When it is an inbound deposit from a business entity, prefer the most specific income category that fits the memo (a dividend or shareholder distribution, a tax distribution, payroll) over a generic one.

The household's own accounts:
${ownAccountList}
${
  balanceAccountList
    ? `
Some of those accounts are tracked by balance only and keep no transaction list of their own — a retirement plan, a brokerage, a mortgage. When a transaction is money moving into or out of one of THESE accounts specifically (a 401k deferral, a brokerage contribution or withdrawal, a mortgage or loan payment), set transferAccountId to its id below. Leave transferAccountId null in every other case, including ordinary purchases, fees charged by that institution, and movement between two accounts that both keep transaction lists.

Balance-only accounts:
${balanceAccountList}
`
    : ""
}
Categories:
${categoryList}`,
      user: JSON.stringify(
        batch.map((b) => ({
          id: b.id,
          merchant: b.merchant,
          description: b.description,
          amountCents: b.amountCents,
          date: b.date,
        })),
      ),
      schema: AssignmentsSchema,
      schemaName: "category_assignments",
    });

    const byId = new Map(batch.map((b) => [b.id, b]));
    for (const a of result.assignments) {
      const txn = byId.get(a.id);
      if (!txn) continue;

      // A named far side settles the row on its own: `linkTransferToAccount`
      // files it with the transfer category the account calls for, which is a
      // better answer than whatever category came back beside it. Held to the
      // same confidence floor, and to ids that are actually balance accounts.
      if (
        a.transferAccountId != null &&
        balanceAccountIds.has(a.transferAccountId) &&
        a.confidence >= AI_CONFIDENCE_THRESHOLD
      ) {
        const err = await linkTransferToAccount(txn.id, a.transferAccountId, "ai");
        if (!err) {
          stats.accountsLinked++;
          continue;
        }
      }

      if (
        a.categoryId == null ||
        !categoryIds.has(a.categoryId) ||
        a.confidence < AI_CONFIDENCE_THRESHOLD
      ) {
        stats.lowConfidence++;
        continue;
      }
      // Reject an income category on a credit-card credit outright, and keep
      // it out of merchant memory so the mistake cannot be replayed for free.
      if (
        guardLiabilityCredit(txn, txn.accountType, a.categoryId, allCategories) === null
      ) {
        stats.blocked++;
        continue;
      }
      await db
        .update(t)
        .set({ categoryId: a.categoryId, categorySource: "ai" })
        .where(eq(t.id, txn.id));
      await recordAiChoice(txn.merchant, a.categoryId);
      stats.fromAi++;
    }
  }

  return stats;
}

export function lookupMemory(
  merchant: string,
  memory: MemoryRow[],
): MemoryRow | null {
  if (!merchant) return null;
  const exact = memory.find((m) => m.normalizedMerchant === merchant);
  if (exact) return exact;
  if (merchant.length < 6) return null;
  const candidates = memory.filter(
    (m) =>
      m.normalizedMerchant.length >= 6 &&
      (merchant.startsWith(m.normalizedMerchant) ||
        m.normalizedMerchant.startsWith(merchant)),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.source !== b.source) return a.source === "user" ? -1 : 1;
    return b.useCount - a.useCount;
  });
  return candidates[0];
}
