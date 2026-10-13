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

const hoje = new Date();
const mes = (delta) => {
  const d = new Date(hoje.getFullYear(), hoje.getMonth() + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const reg = await call('POST', '/auth/register', { name: 'Orc', email: `oc${Date.now()}@t.com`, password: '123456' });
token = reg.body.token;
const conta = (await call('GET', '/accounts')).body[0].id;
const cats = (await call('GET', '/categories')).body;
const alimentacao = cats.find((c) => c.name === 'Alimentação').id;
const transporte = cats.find((c) => c.name === 'Transporte').id;
const lazer = cats.find((c) => c.name === 'Lazer & Viagem').id;
const salario = cats.find((c) => c.name === 'Salário').id;

const gasto = (valor, m, categoria, dia = '05') =>
  call('POST', '/transactions', {
    amount: valor, type: 'despesa', date: `${m}-${dia}`, payment_method: 'dinheiro',
    account_id: conta, category_id: categoria, description: 'Teste',
  });
const doMes = async (m) => (await call('GET', `/budgets?month=${m}`)).body;
const da = (lista, categoria) => lista.find((b) => b.categoryId === categoria);

// ---- recorrência: definir uma vez vale para os meses seguintes ----
let r = await call('POST', '/budgets', { category_id: alimentacao, month_ref: mes(-3), limit_amount: 800 });
check('cria orçamento', r.status === 201, r.body);
check('vale no próprio mês', da(await doMes(mes(-3)), alimentacao)?.limitAmount === 800, await doMes(mes(-3)));
check('vale no mês seguinte sem refazer', da(await doMes(mes(-2)), alimentacao)?.limitAmount === 800, await doMes(mes(-2)));
check('vale até hoje', da(await doMes(mes(0)), alimentacao)?.limitAmount === 800, await doMes(mes(0)));
check('não vale antes de ser criado', !da(await doMes(mes(-4)), alimentacao), await doMes(mes(-4)));
let atual = da(await doMes(mes(0)), alimentacao);
check('informa desde quando vale', atual.since === mes(-3) && atual.inherited === true, atual);
check('no mês de criação não é herdado', da(await doMes(mes(-3)), alimentacao).inherited === false, null);

// ---- mudar daqui pra frente ----
r = await call('POST', '/budgets', { category_id: alimentacao, month_ref: mes(-1), limit_amount: 1000 });
check('mudança daqui pra frente aceita', r.status === 201 && r.body.scope === 'daqui_pra_frente', r.body);
check('antes da mudança segue o valor antigo', da(await doMes(mes(-2)), alimentacao).limitAmount === 800, null);
check('a partir da mudança vale o novo', da(await doMes(mes(0)), alimentacao).limitAmount === 1000, null);
check('meses futuros herdam o novo', da(await doMes(mes(2)), alimentacao).limitAmount === 1000, null);

// ---- mudar só este mês ----
r = await call('POST', '/budgets', { category_id: alimentacao, month_ref: mes(0), limit_amount: 1500, scope: 'so_este_mes' });
check('mudança só deste mês aceita', r.status === 201 && r.body.scope === 'so_este_mes', r.body);
check('este mês com o valor especial', da(await doMes(mes(0)), alimentacao).limitAmount === 1500, null);
check('mês seguinte volta ao valor anterior', da(await doMes(mes(1)), alimentacao).limitAmount === 1000, await doMes(mes(1)));
check('e continua depois', da(await doMes(mes(3)), alimentacao).limitAmount === 1000, null);

// só este mês numa categoria que não tinha orçamento: o mês seguinte fica sem
r = await call('POST', '/budgets', { category_id: lazer, month_ref: mes(0), limit_amount: 300, scope: 'so_este_mes' });
check('orçamento pontual numa categoria nova', da(await doMes(mes(0)), lazer)?.limitAmount === 300, null);
check('no mês seguinte ela volta a não ter orçamento', !da(await doMes(mes(1)), lazer), await doMes(mes(1)));

// ---- encerrar ----
await call('POST', '/budgets', { category_id: transporte, month_ref: mes(-2), limit_amount: 400 });
r = await call('DELETE', `/budgets/category/${transporte}?month=${mes(0)}`);
check('encerra daqui pra frente', r.status === 204, r.body);
check('some neste mês', !da(await doMes(mes(0)), transporte), null);
check('some nos seguintes', !da(await doMes(mes(2)), transporte), null);
check('histórico anterior continua', da(await doMes(mes(-1)), transporte)?.limitAmount === 400, await doMes(mes(-1)));

r = await call('DELETE', `/budgets/category/${alimentacao}?month=${mes(1)}&scope=so_este_mes`);
check('pausa só um mês', r.status === 204, r.body);
check('o mês pausado fica sem orçamento', !da(await doMes(mes(1)), alimentacao), null);
check('o mês depois do pausado volta', da(await doMes(mes(2)), alimentacao)?.limitAmount === 1000, await doMes(mes(2)));

// volta a definir depois de encerrar
await call('POST', '/budgets', { category_id: transporte, month_ref: mes(1), limit_amount: 450 });
check('reativa depois de encerrado', da(await doMes(mes(1)), transporte)?.limitAmount === 450, null);
check('e o mês encerrado segue sem', !da(await doMes(mes(0)), transporte), null);

// ---- gasto, média e ritmo ----
await gasto(600, mes(-3), alimentacao);
await gasto(900, mes(-2), alimentacao);
await gasto(1200, mes(-1), alimentacao);
await gasto(300, mes(0), alimentacao, '01');
atual = da(await doMes(mes(0)), alimentacao);
check('soma o gasto do mês', atual.spent === 300, atual);
check('média dos três meses anteriores', atual.average === 900, atual);
check('projeção no mês corrente cresce com o ritmo', atual.projection >= atual.spent, atual);
const passado = da(await doMes(mes(-1)), alimentacao);
check('mês fechado: projeção = gasto', passado.projection === passado.spent, passado);
check('mês fechado acima do limite = estourou', passado.pace === 'estourou', passado);

// ---- sugestões ----
await gasto(200, mes(-2), lazer);
await gasto(350, mes(-1), lazer);
// Neste mês o Lazer tem orçamento pontual: não é sugerido.
r = await call('GET', `/budgets/suggestions?month=${mes(0)}`);
check('quem tem orçamento no mês não é sugerido', !r.body.some((s) => s.categoryId === lazer), r.body);
// Daqui a dois meses ele não tem; a média usa os três meses anteriores (350 + 0 + 0).
r = await call('GET', `/budgets/suggestions?month=${mes(2)}`);
const sugLazer = r.body.find((s) => s.categoryId === lazer);
check('sugere para categoria com gasto e sem orçamento', !!sugLazer, r.body);
check('não sugere quem tem orçamento recorrente', !r.body.some((s) => s.categoryId === alimentacao), r.body);
check('sugestão é a média, arredondada para cima de 50 em 50',
  sugLazer && sugLazer.average === 116.67 && sugLazer.suggested === 150, sugLazer);
check('informa quantos meses tiveram gasto', sugLazer?.monthsWithSpending === 1, sugLazer);

// ---- validações e permissões ----
r = await call('POST', '/budgets', { category_id: salario, month_ref: mes(0), limit_amount: 100 });
check('receita não tem orçamento -> 400', r.status === 400, r.body);
r = await call('POST', '/budgets', { category_id: alimentacao, month_ref: mes(0), limit_amount: 0 });
check('limite zero -> 400', r.status === 400, r.body);
r = await call('DELETE', `/budgets/category/${alimentacao}`);
check('encerrar sem mês -> 400', r.status === 400, r.body);
r = await call('GET', '/budgets/suggestions');
check('sugestões sem mês -> 400', r.status === 400, r.body);

const t1 = token;
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `oo${Date.now()}@t.com`, password: '123456' });
token = outro.body.token;
r = await call('DELETE', `/budgets/category/${alimentacao}?month=${mes(0)}`);
check('não encerra orçamento de outro usuário', r.status === 404, r.body);
r = await call('POST', '/budgets', { category_id: alimentacao, month_ref: mes(0), limit_amount: 1 });
check('não define orçamento em categoria de outro usuário', r.status === 404, r.body);
check('outro usuário não vê os orçamentos', (await doMes(mes(0))).length === 0, null);
token = t1;
check('orçamento original intacto', da(await doMes(mes(0)), alimentacao).limitAmount === 1500, null);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
