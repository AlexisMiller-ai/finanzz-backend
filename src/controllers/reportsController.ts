import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { parseDate, sendError, todayInBrazil } from "../utils/validation";

/**
 * Relatório de um período livre: para onde o dinheiro foi, como isso se
 * compara com o período anterior do mesmo tamanho, e a evolução dentro dele.
 *
 * Transferências ficam de fora (dinheiro mudando de lugar não é receita nem
 * despesa). Lançamentos pendentes entram nos totais — é o resultado do
 * período —, mas são informados à parte para o que ainda não aconteceu ficar
 * visível.
 */

const MAX_DIAS = 1830; // ~5 anos
/** Até uns três meses o gráfico fica por semana; acima disso, por mês. */
const DIAS_PARA_AGRUPAR_POR_MES = 92;

const DIA_EM_MS = 86_400_000;
const diasEntre = (de: string, ate: string) =>
  Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA_EM_MS);
const somaDias = (data: string, dias: number) =>
  new Date(Date.parse(`${data}T00:00:00Z`) + dias * DIA_EM_MS).toISOString().slice(0, 10);

const num = (valor: unknown) => Math.round(parseFloat(String(valor ?? 0)) * 100) / 100;

type Totais = { entradas: number; saidas: number; saldo: number; lancamentos: number };

async function totaisDoPeriodo(
  userId: number | undefined,
  de: string,
  ate: string,
): Promise<Totais & { pendentes: { quantidade: number; valor: number } }> {
  const resultado = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'receita'), 0) AS entradas,
            COALESCE(SUM(amount) FILTER (WHERE type = 'despesa'), 0) AS saidas,
            COUNT(*)::int AS lancamentos,
            COUNT(*) FILTER (WHERE NOT settled)::int AS pendentes_quantidade,
            COALESCE(SUM(amount) FILTER (WHERE NOT settled), 0) AS pendentes_valor
       FROM transactions
      WHERE user_id = $1 AND transfer_id IS NULL AND date >= $2::date AND date <= $3::date`,
    [userId, de, ate],
  );
  const linha = resultado.rows[0];
  const entradas = num(linha.entradas);
  const saidas = num(linha.saidas);
  return {
    entradas,
    saidas,
    saldo: Math.round((entradas - saidas) * 100) / 100,
    lancamentos: linha.lancamentos,
    pendentes: {
      quantidade: linha.pendentes_quantidade,
      valor: num(linha.pendentes_valor),
    },
  };
}

async function porCategoria(userId: number | undefined, de: string, ate: string) {
  const resultado = await pool.query(
    `SELECT t.category_id, t.type,
            COALESCE(c.name, 'Sem categoria') AS name,
            COALESCE(c.color, '#94A3B8') AS color,
            SUM(t.amount) AS total,
            COUNT(*)::int AS quantidade
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = $1 AND t.transfer_id IS NULL AND t.date >= $2::date AND t.date <= $3::date
      GROUP BY t.category_id, t.type, c.name, c.color`,
    [userId, de, ate],
  );
  return resultado.rows;
}

export const getReport = async (req: AuthRequest, res: Response) => {
  const hoje = todayInBrazil();
  const de = parseDate(req.query.from);
  const ate = parseDate(req.query.to) ?? hoje;
  if (req.query.from !== undefined && !de) return sendError(res, 400, 'Parâmetro "from" inválido');
  if (req.query.to !== undefined && !parseDate(req.query.to)) {
    return sendError(res, 400, 'Parâmetro "to" inválido');
  }
  // Sem período informado, os últimos 6 meses.
  const inicio = de ?? somaDias(ate, -182);
  if (inicio > ate) return sendError(res, 400, "A data inicial precisa vir antes da final");

  const dias = diasEntre(inicio, ate) + 1;
  if (dias > MAX_DIAS) return sendError(res, 400, "Período muito longo (máximo 5 anos)");

  // Período anterior do mesmo tamanho, para comparar.
  const anteriorAte = somaDias(inicio, -1);
  const anteriorDe = somaDias(anteriorAte, -(dias - 1));
  const agrupamento = dias > DIAS_PARA_AGRUPAR_POR_MES ? "month" : "week";

  try {
    const [resumo, anterior, categorias, categoriasAntes, linha, maiores] = await Promise.all([
      totaisDoPeriodo(req.userId, inicio, ate),
      totaisDoPeriodo(req.userId, anteriorDe, anteriorAte),
      porCategoria(req.userId, inicio, ate),
      porCategoria(req.userId, anteriorDe, anteriorAte),
      pool.query(
        `SELECT to_char(date_trunc($4, date), 'YYYY-MM-DD') AS inicio,
                COALESCE(SUM(amount) FILTER (WHERE type = 'receita'), 0) AS entradas,
                COALESCE(SUM(amount) FILTER (WHERE type = 'despesa'), 0) AS saidas
           FROM transactions
          WHERE user_id = $1 AND transfer_id IS NULL AND date >= $2::date AND date <= $3::date
          GROUP BY 1 ORDER BY 1`,
        [req.userId, inicio, ate, agrupamento],
      ),
      pool.query(
        `SELECT t.id, t.description, t.amount, t.date, t.settled,
                c.name AS category_name, c.color AS category_color,
                COALESCE(cd.name, a.name) AS origem
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           LEFT JOIN accounts a ON a.id = t.account_id
           LEFT JOIN cards cd ON cd.id = t.card_id
          WHERE t.user_id = $1 AND t.transfer_id IS NULL AND t.type = 'despesa'
            AND t.date >= $2::date AND t.date <= $3::date
          ORDER BY t.amount DESC, t.id DESC
          LIMIT 8`,
        [req.userId, inicio, ate],
      ),
    ]);

    const meses = dias / 30.44;
    const anteriorPorChave = new Map(
      categoriasAntes.map((linha) => [`${linha.type}:${linha.category_id ?? 0}`, num(linha.total)]),
    );

    const montarCategorias = (tipo: "despesa" | "receita") => {
      const doTipo = categorias.filter((linha) => linha.type === tipo);
      const totalDoTipo = doTipo.reduce((soma, linha) => soma + num(linha.total), 0);
      return doTipo
        .map((linha) => {
          const total = num(linha.total);
          const antes = anteriorPorChave.get(`${tipo}:${linha.category_id ?? 0}`) ?? 0;
          return {
            categoryId: linha.category_id,
            name: linha.name,
            color: linha.color,
            total,
            quantidade: linha.quantidade,
            percentual: totalDoTipo > 0 ? Math.round((total / totalDoTipo) * 1000) / 10 : 0,
            mediaMensal: Math.round((total / meses) * 100) / 100,
            anterior: antes,
            // null quando não havia nada antes: não dá para falar em variação.
            variacao: antes > 0 ? Math.round(((total - antes) / antes) * 1000) / 10 : null,
          };
        })
        .sort((a, b) => b.total - a.total);
    };

    res.json({
      periodo: { de: inicio, ate, dias, meses: Math.round(meses * 10) / 10, agrupamento },
      anteriorPeriodo: { de: anteriorDe, ate: anteriorAte },
      resumo: {
        ...resumo,
        mediaMensalSaidas: Math.round((resumo.saidas / meses) * 100) / 100,
        mediaMensalEntradas: Math.round((resumo.entradas / meses) * 100) / 100,
      },
      anterior,
      despesasPorCategoria: montarCategorias("despesa"),
      receitasPorCategoria: montarCategorias("receita"),
      linhaDoTempo: linha.rows.map((ponto) => {
        const entradas = num(ponto.entradas);
        const saidas = num(ponto.saidas);
        return {
          inicio: ponto.inicio,
          entradas,
          saidas,
          saldo: Math.round((entradas - saidas) * 100) / 100,
        };
      }),
      maioresGastos: maiores.rows.map((linha) => ({
        id: linha.id,
        descricao: linha.description,
        valor: num(linha.amount),
        data: linha.date,
        settled: linha.settled,
        categoria: linha.category_name,
        cor: linha.category_color,
        origem: linha.origem,
      })),
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao gerar o relatório");
  }
};
