import "dotenv/config";
import { createHash } from "node:crypto";
import { db, schema } from "../app/.server/db";

import { STARTER_CATEGORIES } from "../app/db/starter-categories";

const { categories, accounts, transactions, balanceSnapshots } = schema;

async function seedBase() {
  for (const c of STARTER_CATEGORIES) {
    await db.insert(categories).values(c).onConflictDoNothing();
  }
  console.log(`Seeded ${STARTER_CATEGORIES.length} categories.`);
}

// --- fake data generation (--fake N) for pagination/perf testing ---

const FAKE_MERCHANTS: { desc: string; merchant: string; min: number; max: number; cat: string }[] = [
  { desc: "KROGER #442 SPRINGFIELD", merchant: "KROGER", min: 2500, max: 24000, cat: "Groceries" },
  { desc: "COSTCO WHSE #1121", merchant: "COSTCO WHSE", min: 8000, max: 42000, cat: "Groceries" },
  { desc: "SHELL OIL 57442199", merchant: "SHELL OIL", min: 2800, max: 8500, cat: "Gas & Auto" },
  { desc: "CHIPOTLE 2211", merchant: "CHIPOTLE", min: 1100, max: 4200, cat: "Restaurants" },
  { desc: "TST* THE GREEN FORK", merchant: "THE GREEN FORK", min: 3500, max: 12000, cat: "Restaurants" },
  { desc: "NETFLIX.COM", merchant: "NETFLIX", min: 1599, max: 1599, cat: "Subscriptions" },
  { desc: "SPOTIFY USA", merchant: "SPOTIFY USA", min: 1199, max: 1199, cat: "Subscriptions" },
  { desc: "AMZN MKTP US*Z128KJ3", merchant: "AMAZON", min: 900, max: 18000, cat: "Shopping" },
  { desc: "AMAZON.COM*MM2456", merchant: "AMAZON", min: 1200, max: 26000, cat: "Shopping" },
  { desc: "CITY OF SPRINGFIELD UTIL", merchant: "CITY OF SPRINGFIELD UTIL", min: 9000, max: 26000, cat: "Utilities" },
  { desc: "AMERICAN ELECTRIC PWR", merchant: "AMERICAN ELECTRIC PWR", min: 7000, max: 21000, cat: "Utilities" },
  { desc: "WELLPOINT MORTGAGE PMT", merchant: "WELLPOINT MORTGAGE PMT", min: 214500, max: 214500, cat: "Mortgage" },
  { desc: "SQ *CORNER COFFEE", merchant: "CORNER COFFEE", min: 450, max: 1600, cat: "Restaurants" },
  { desc: "TARGET 00021221", merchant: "TARGET", min: 1500, max: 22000, cat: "Household Supplies" },
  { desc: "WALGREENS #5521", merchant: "WALGREENS", min: 600, max: 9000, cat: "Health" },
  { desc: "AMC THEATRES 4422", merchant: "AMC THEATRES", min: 2400, max: 8800, cat: "Entertainment" },
];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedFake(count: number) {
  const rand = mulberry32(20260728);
  const allCats = await db.select().from(categories);
  const catByName = new Map(allCats.map((c) => [c.name, c.id]));

  const [checking] = await db
    .insert(accounts)
    .values({
      name: "Household Checking",
      institution: "Fake Bank",
      kind: "transaction",
      accountType: "checking",
    })
    .onConflictDoNothing()
    .returning();
  const [card] = await db
    .insert(accounts)
    .values({
      name: "Household Card",
      institution: "Fake Card Co",
      kind: "transaction",
      accountType: "credit_card",
    })
    .onConflictDoNothing()
    .returning();
  const [invest] = await db
    .insert(accounts)
    .values({
      name: "Brokerage",
      institution: "Fake Invest",
      kind: "balance",
      accountType: "investment",
    })
    .onConflictDoNothing()
    .returning();

  const start = new Date(Date.UTC(2023, 0, 1)).getTime();
  const span = Date.UTC(2026, 6, 1) - start;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const m = FAKE_MERCHANTS[Math.floor(rand() * FAKE_MERCHANTS.length)];
    const date = new Date(start + rand() * span).toISOString().slice(0, 10);
    const amountCents = -Math.round(m.min + rand() * (m.max - m.min));
    const account = rand() < 0.5 ? checking : card;
    const categorized = rand() < 0.7;
    rows.push({
      accountId: account.id,
      date,
      amountCents,
      description: m.desc,
      merchant: m.merchant,
      categoryId: categorized ? (catByName.get(m.cat) ?? null) : null,
      categorySource: categorized ? ("user" as const) : null,
      dedupeHash: createHash("sha256").update(`fake|${i}`).digest("hex"),
    });
    // Monthly salary deposits
    if (i % 120 === 0) {
      rows.push({
        accountId: checking.id,
        date,
        amountCents: 650000 + Math.round(rand() * 50000),
        description: "DIRECT DEP EMPLOYER PAYROLL",
        merchant: "EMPLOYER PAYROLL",
        categoryId: catByName.get("Salary") ?? null,
        categorySource: "user" as const,
        dedupeHash: createHash("sha256").update(`fake-salary|${i}`).digest("hex"),
      });
    }
  }
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(transactions).values(rows.slice(i, i + CHUNK));
  }

  // Investment balance snapshots, monthly upward drift
  if (invest) {
    let balance = 4_200_000;
    const snaps = [];
    for (let y = 2023; y <= 2026; y++) {
      for (let m = 1; m <= 12; m++) {
        if (y === 2026 && m > 7) break;
        balance = Math.round(balance * (0.985 + rand() * 0.05));
        snaps.push({
          accountId: invest.id,
          date: `${y}-${String(m).padStart(2, "0")}-28`,
          balanceCents: balance,
          source: "import" as const,
        });
      }
    }
    for (const s of snaps) {
      await db.insert(balanceSnapshots).values(s).onConflictDoNothing();
    }
  }
  console.log(`Seeded ${rows.length} fake transactions + balance snapshots.`);
}

const fakeIdx = process.argv.indexOf("--fake");
await seedBase();
if (fakeIdx !== -1) {
  await seedFake(parseInt(process.argv[fakeIdx + 1] ?? "12000", 10));
}
