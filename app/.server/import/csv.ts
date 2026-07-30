import Papa from "papaparse";

export interface ParsedCsv {
  headers: string[];
  records: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const headers = (result.meta.fields ?? []).filter(Boolean);
  return { headers, records: result.data };
}

export function headerSignature(headers: string[]): string {
  return headers.map((h) => h.toLowerCase()).join("|");
}
