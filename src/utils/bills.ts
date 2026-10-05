import { addMonths } from "./validation";

/** Último dia do mês de uma data "YYYY-MM-DD". */
function lastDayOfMonth(date: string): number {
  const [y = 1970, m = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Dia do mês, limitado ao último dia existente (dia 31 em fevereiro = 28). */
export function dayInMonth(month: string, day: number): string {
  const clamped = Math.min(day, lastDayOfMonth(month));
  return `${month.slice(0, 7)}-${String(clamped).padStart(2, "0")}`;
}

/**
 * Mês da fatura que ainda está aberta (a que continua recebendo compras).
 * A partir do dia de fechamento, as compras já entram na fatura do mês
 * seguinte — a mesma regra que o formulário de lançamento usa. Sem dia de
 * fechamento, a fatura aberta é a do mês corrente.
 */
export function openBillMonth(closingDay: number | null, today: string): string {
  const month = `${today.slice(0, 7)}-01`;
  const day = Number(today.slice(8, 10));
  return closingDay && day >= closingDay ? addMonths(month, 1) : month;
}

/** Dia em que a fatura do mês fecha, se o cartão tiver essa data definida. */
export function billClosingDate(month: string, closingDay: number | null): string | null {
  return closingDay ? dayInMonth(month, closingDay) : null;
}

/** Vencimento da fatura do mês; se vence antes de fechar, é no mês seguinte. */
export function billDueDate(
  month: string,
  closingDay: number | null,
  dueDay: number | null,
): string | null {
  if (!dueDay) return null;
  const base = closingDay && dueDay < closingDay ? addMonths(month, 1) : month;
  return dayInMonth(base, dueDay);
}
