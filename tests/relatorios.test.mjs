const B = process.env.API_URL ?? 'http://localhost:3334';
let token; let fails = 0;
const call = async (method, path, body) => {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let json; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json };
};
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra)));
  if (!cond) fails++;
};

const reg = await call('POST', '/auth/register', { name: 'Rel', email: `rl${Date.now()}@t.com`, password: 'senha-teste-123' });
token = reg.body.token;
const conta = (await call('GET', '/accounts')).body[0].id;
const outraConta = (await call('POST', '/accounts', { name: 'Poupança', kind: 'poupanca' })).body.id;
const categorias = (await call('GET', '/categories')).body;
const mercado = categorias.find((c) => c.name === 'Alimentação').id;
const transporte = categorias.find((c) => c.name === 'Transporte').id;
const salario = categorias.find((c) => c.name === 'Salário').id;

const lancar = (valor, tipo, data, categoria, extra = {}) =>
  call('POST', '/transactions', {
    amount: valor, type: tipo, date: data, payment_method: 'dinheiro',
    account_id: conta, category_id: categoria, description: extra.descricao ?? 'Teste',
    ...extra,
  });

// Período do relatório: 01/03 a 30/04. Período anterior equivalente: 30/12 a 28/02.
await lancar(1000, 'despesa', '2026-03-10', mercado, { descricao: 'Mercado março' });
await lancar(500, 'despesa', '2026-04-10', mercado, { descricao: 'Mercado abril' });
await lancar(300, 'despesa', '2026-04-15', transporte, { descricao: 'Uber' });
await lancar(4000, 'receita', '2026-03-05', salario, { descricao: 'Salário março' });
await lancar(200, 'despesa', '2026-04-20', null, { descricao: 'Sem categoria' });
// no período anterior
await lancar(600, 'despesa', '2026-01-10', mercado, { descricao: 'Mercado janeiro' });
await lancar(2000, 'receita', '2026-02-05', salario, { descricao: 'Salário fevereiro' });
// fora dos dois períodos
await lancar(9999, 'despesa', '2025-06-01', mercado, { descricao: 'Antigo demais' });
// transferência não pode aparecer
await call('POST', '/transfers', { from_account_id: conta, to_account_id: outraConta, amount: 777, date: '2026-03-20' });
// pendente entra no total, mas é informado à parte
await lancar(150, 'despesa', '2026-04-25', transporte, { descricao: 'A pagar', settled: false });

let r = await call('GET', '/reports?from=2026-03-01&to=2026-04-30');
const rel = r.body;
check('responde 200', r.status === 200, r.status);
check('período volta como pedido', rel.periodo.de === '2026-03-01' && rel.periodo.ate === '2026-04-30', rel.periodo);
check('conta os dias do período', rel.periodo.dias === 61, rel.periodo);
check('soma as saídas do período', rel.resumo.saidas === 2150, rel.resumo);
check('soma as entradas do período', rel.resumo.entradas === 4000, rel.resumo);
check('saldo = entradas - saídas', rel.resumo.saldo === 1850, rel.resumo);
check('transferência fica fora', rel.resumo.lancamentos === 6, rel.resumo);
check('informa o que está pendente', rel.resumo.pendentes.quantidade === 1 && rel.resumo.pendentes.valor === 150, rel.resumo);
check('média mensal de saídas', rel.resumo.mediaMensalSaidas === 1072.89, rel.resumo);

check('período anterior tem o mesmo tamanho',
  rel.anteriorPeriodo.de === '2025-12-30' && rel.anteriorPeriodo.ate === '2026-02-28', rel.anteriorPeriodo);
check('totais do período anterior', rel.anterior.saidas === 600 && rel.anterior.entradas === 2000, rel.anterior);

const alimentacao = rel.despesasPorCategoria.find((c) => c.name === 'Alimentação');
const uber = rel.despesasPorCategoria.find((c) => c.name === 'Transporte');
const semCategoria = rel.despesasPorCategoria.find((c) => c.name === 'Sem categoria');
check('categorias vêm da maior para a menor', rel.despesasPorCategoria[0].name === 'Alimentação', rel.despesasPorCategoria.map((c) => c.name));
check('soma por categoria', alimentacao.total === 1500 && alimentacao.quantidade === 2, alimentacao);
check('percentual dentro das despesas', alimentacao.percentual === 69.8, alimentacao);
check('média mensal por categoria', alimentacao.mediaMensal === 748.52, alimentacao);
check('compara com o período anterior', alimentacao.anterior === 600 && alimentacao.variacao === 150, alimentacao);
check('sem base anterior, variação é nula', uber.variacao === null && uber.anterior === 0, uber);
check('lançamento sem categoria aparece agrupado', semCategoria.total === 200, semCategoria);
check('receita por categoria vem separada',
  rel.receitasPorCategoria.length === 1 && rel.receitasPorCategoria[0].total === 4000, rel.receitasPorCategoria);

check('até três meses a linha do tempo é por semana', rel.periodo.agrupamento === 'week', rel.periodo);
check('cada ponto é uma semana com movimento', rel.linhaDoTempo.length === 5, rel.linhaDoTempo);
check('a semana do salário mostra a entrada', rel.linhaDoTempo[0].entradas === 4000 && rel.linhaDoTempo[0].saldo === 4000, rel.linhaDoTempo[0]);

// período longo: a linha do tempo passa a ser por mês
let longo = (await call('GET', '/reports?from=2026-01-01&to=2026-06-30')).body;
check('acima de três meses agrupa por mês', longo.periodo.agrupamento === 'month', longo.periodo);
check('um ponto por mês com movimento', longo.linhaDoTempo.length === 4, longo.linhaDoTempo.map((p) => p.inicio));
check('ponto de março fecha o mês inteiro',
  longo.linhaDoTempo.find((p) => p.inicio === '2026-03-01').saldo === 3000, longo.linhaDoTempo);

check('maiores gastos vêm ordenados', rel.maioresGastos[0].valor === 1000 && rel.maioresGastos[0].descricao === 'Mercado março', rel.maioresGastos);
check('maiores gastos não trazem receita nem transferência',
  rel.maioresGastos.every((g) => g.valor <= 1000) && rel.maioresGastos.length === 5, rel.maioresGastos);
check('maior gasto mostra a origem', rel.maioresGastos[0].origem === 'Conta principal', rel.maioresGastos[0]);

// ---- período curto agrupa por semana ----
r = await call('GET', '/reports?from=2026-04-01&to=2026-04-30');
check('período curto agrupa por semana', r.body.periodo.agrupamento === 'week', r.body.periodo);
check('semanas da linha do tempo', r.body.linhaDoTempo.length >= 3, r.body.linhaDoTempo);

// ---- padrão: últimos 6 meses até hoje ----
r = await call('GET', '/reports');
check('sem parâmetros, usa os últimos ~6 meses', r.status === 200 && r.body.periodo.dias === 183, r.body.periodo);

// ---- validações ----
r = await call('GET', '/reports?from=2026-13-01');
check('data inicial inválida -> 400', r.status === 400, r.body);
r = await call('GET', '/reports?from=2026-04-01&to=2026-03-01');
check('fim antes do início -> 400', r.status === 400, r.body);
r = await call('GET', '/reports?from=2000-01-01&to=2026-01-01');
check('período longo demais -> 400', r.status === 400, r.body);

// ---- isolamento ----
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `or${Date.now()}@t.com`, password: 'senha-teste-123' });
token = outro.body.token;
r = await call('GET', '/reports?from=2026-03-01&to=2026-04-30');
check('cada um vê só os próprios números', r.body.resumo.saidas === 0 && r.body.resumo.lancamentos === 0, r.body.resumo);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
