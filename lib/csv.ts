import Papa from "papaparse";

export function parseCsv(text: string): Record<string, string>[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return result.data;
}

// orders.csv uses "YYYY-MM-DD HH:MM:SS"
export function parseOrderDate(s: string|''): Date {
  if (!s) {
    return new Date();
  }
  return new Date(s.trim().replace(" ", "T"));
}

// payments.csv uses "DD/MM/YYYY HH:MM"
export function parsePaymentDate(s: string): 
Date {
  if(!s) {
    return new Date(0, 0, 0, 0, 0);
  }
  const [datePart, timePart] = s?.trim()?.split(" ");
  const [day, month, year] = datePart?.split("/")?.map(Number);
  const [hour, minute] = (timePart ?? "00:00")?.split(":")?.map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

export function normId(s: string): string {
  return (s ?? "").trim().toUpperCase();
}

export function num(s: string): number {
  const n = parseFloat((s ?? "0").trim());
  return isNaN(n) ? 0 : n;
}
