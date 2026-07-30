import type { SpendingClass } from "~/db/schema";

export const STARTER_CATEGORIES: {
  name: string;
  spendingClass: SpendingClass;
  sortOrder: number;
}[] = [
  { name: "Mortgage", spendingClass: "base", sortOrder: 0 },
  { name: "Utilities", spendingClass: "base", sortOrder: 1 },
  { name: "Insurance", spendingClass: "base", sortOrder: 2 },
  { name: "Internet & Phone", spendingClass: "base", sortOrder: 3 },
  { name: "Childcare", spendingClass: "base", sortOrder: 4 },
  { name: "Groceries", spendingClass: "living", sortOrder: 10 },
  { name: "Gas & Auto", spendingClass: "living", sortOrder: 11 },
  { name: "Health", spendingClass: "living", sortOrder: 12 },
  { name: "Household Supplies", spendingClass: "living", sortOrder: 13 },
  { name: "Restaurants", spendingClass: "luxury", sortOrder: 20 },
  { name: "Entertainment", spendingClass: "luxury", sortOrder: 21 },
  { name: "Shopping", spendingClass: "luxury", sortOrder: 22 },
  { name: "Travel", spendingClass: "luxury", sortOrder: 23 },
  { name: "Subscriptions", spendingClass: "luxury", sortOrder: 24 },
  { name: "Salary", spendingClass: "income", sortOrder: 30 },
  { name: "Dividends", spendingClass: "income", sortOrder: 31 },
  { name: "Tax Distribution", spendingClass: "income", sortOrder: 32 },
  { name: "Other Income", spendingClass: "income", sortOrder: 33 },
  { name: "Transfer", spendingClass: "transfer", sortOrder: 40 },
  { name: "Credit Card Payment", spendingClass: "transfer", sortOrder: 41 },
];
