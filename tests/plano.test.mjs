// Plano do mês: a meta de economia vale a partir do mês em que foi definida e
// continua valendo nos seguintes, até ser mudada ou encerrada.
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

const reg = await call('POST', '/auth/register', { name: 'Plano', email: `pl${Date.now()}@t.com`, password: 'senha-teste-123' });
token = reg.body.token;
const conta = (await call('GET', '/accounts')).body[0].id;
const salario = (await call('GET', '/categories')).body.find((c) => c.name === 'Salário').id;

const meta = (mes) => call('GET', `/goals?month=${mes}`);
const definir = (mes, valor) => call('POST', '/goals', { month_ref: `${mes}-01`, savings_goal: valor });

// --- sem meta ---
let r = await meta('2026-03');
check('sem meta definida, devolve zero', r.body.savingsGoal === 0 && r.body.fromMonth === null, r.body);

// --- meta vale do mês em diante ---
r = await definir('2026-03', 500);
check('define a meta', r.status === 201, r.body);
check('vale no mês em que foi definida', (await meta('2026-03')).body.savingsGoal === 500);
check('continua valendo no mês seguinte', (await meta('2026-04')).body.savingsGoal === 500);
check('continua valendo meses depois', (await meta('2026-09')).body.savingsGoal === 500);
check('não vale em meses anteriores', (await meta('2026-02')).body.savingsGoal === 0);
r = await meta('2026-09');
check('informa de qual mês veio', r.body.fromMonth === '2026-03-01', r.body);

// --- mudança no meio do caminho ---
await definir('2026-06', 800);
check('mês anterior à mudança mantém o valor antigo', (await meta('2026-05')).body.savingsGoal === 500);
check('mês da mudança usa o novo valor', (await meta('2026-06')).body.savingsGoal === 800);
check('depois da mudança segue o novo valor', (await meta('2026-12')).body.savingsGoal === 800);

// --- encerrar ---
r = await definir('2026-08', 0);
check('encerrar a meta é aceito', r.status === 201, r.body);
check('depois de encerrada, zero', (await meta('2026-08')).body.savingsGoal === 0);
check('encerrada continua zero nos meses seguintes', (await meta('2027-01')).body.savingsGoal === 0);
check('histórico antes do encerramento é preservado', (await meta('2026-07')).body.savingsGoal === 800);

// --- o resumo do dashboard usa a mesma meta ---
await call('POST', '/transactions', {
  amount: 3000, type: 'receita', category_id: salario, description: 'Salário',
  date: '2026-06-05', account_id: conta,
});
await call('POST', '/transactions', {
  amount: 1000, type: 'despesa', description: 'Gastos', date: '2026-06-10', account_id: conta,
});
const resumo = (await call('GET', '/dashboard/summary?month=2026-06')).body;
check('resumo aplica a meta vigente', resumo.savingsGoal === 800, resumo);
check('disponível para gastar desconta a meta', resumo.availableToSpend === 3000 - 800 - 1000, resumo);
check('resumo informa de qual mês veio a meta', resumo.savingsGoalFromMonth === '2026-06-01', resumo);

const julho = (await call('GET', '/dashboard/summary?month=2026-07')).body;
check('resumo de mês sem lançamento ainda traz a meta', julho.savingsGoal === 800, julho);

// --- validações ---
check('meta negativa é recusada', (await definir('2026-06', -10)).status === 400);
check('mês inválido é recusado', (await call('POST', '/goals', { month_ref: 'abc', savings_goal: 10 })).status === 400);
check('mês obrigatório na consulta', (await call('GET', '/goals')).status === 400);

// --- isolamento entre usuários ---
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `o${Date.now()}@t.com`, password: 'senha-teste-123' });
token = outro.body.token;
check('meta de um usuário não aparece para outro', (await meta('2026-06')).body.savingsGoal === 0);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
