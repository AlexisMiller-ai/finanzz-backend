import { Response } from "express";

export const TRANSACTION_TYPES = ["despesa", "receita"] as const;
export const PAYMENT_METHODS = ["dinheiro", "debito", "credito"] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function sendError(res: Response, status: number, message: string) {
  return res.status(status).json({ status: "error", message });
}

/** Aceita "2026-09" e devolve "2026-09-01", ou null se inválido. */
export function parseMonth(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return null;
  }
  return `${value}-01`;
}

/** Aceita "2026-09-15" ou "2026-09-01T..." e devolve "YYYY-MM-DD", ou null. */
export function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return value.slice(0, 10);
}

/** Converte um valor monetário em centavos inteiros (> 0), ou null. */
export function toCents(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  const cents = Math.round(num * 100);
  return cents > 0 && cents < 1e10 ? cents : null;
}

export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function parsePositiveInt(value: unknown): number | null {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export function isOneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * Soma meses a uma data "YYYY-MM-DD" mantendo o dia, mas limitando ao último
 * dia do mês (31/01 + 1 mês = 28/02, e não 03/03).
 */
export function addMonths(dateStr: string, months: number): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Data de hoje no fuso de Brasília, formato "YYYY-MM-DD". */
export function todayInBrazil(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
}

export function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}
