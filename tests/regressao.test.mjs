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

// auth
let r = await call('POST', '/auth/register', { name: 'Reg', email: `  Reg${Date.now()}@Mail.com `, password: 'senha-teste-123' });
check('registro normaliza e-mail', r.status === 201 && r.body.user.email === r.body.user.email.toLowerCase(), r.body);
token = r.body.token;
const email = r.body.user.email;
check('login case-insensitive', (await call('POST', '/auth/login', { email: email.toUpperCase(), password: 'senha-teste-123' })).status === 200);

const cats = (await call('GET', '/categories')).body;
const alim = cats.find((c) => c.name === 'Alimentação').id;
const salario = cats.find((c) => c.name === 'Salário').id;
const contas = (await call('GET', '/accounts')).body;
check('conta padrão criada no cadastro', contas.length === 1, contas);

// parcelamento
r = await call('POST', '/transactions', { amount: 1000, type: 'despesa', category_id: alim, description: 'Celular', date: '2026-01-31', payment_method: 'credito', purchase_date: '2026-01-20', is_installment: true, installments: 3 });
const inst = r.body.transactions;
check('parcelas criadas', inst.length === 3, r.body);
check('datas respeitam o fim do mês', inst.map((t) => t.date).join() === '2026-01-31,2026-02-28,2026-03-31', inst.map((t) => t.date));
check('soma das parcelas bate', inst.map((t) => t.amount).join() === '333.33,333.33,333.34', inst.map((t) => t.amount));
check('parcela no crédito vai para um cartão', inst.every((t) => t.card_id && !t.account_id), inst[0]);

// escopos
r = await call('PUT', `/transactions/${inst[0].id}`, { amount: 333.33, type: 'despesa', category_id: alim, description: 'iPhone', date: inst[0].date, purchase_date: '2026-01-20', payment_method: 'credito', scope: 'all' });
check('edição em lote renomeia as parcelas', r.body.transactions.map((t) => t.description).sort().join() === 'iPhone (1/3),iPhone (2/3),iPhone (3/3)', r.body.transactions?.map((t) => t.description));
r = await call('DELETE', `/transactions/${inst[1].id}?scope=future`);
check('exclusão deste e próximos', r.body.deleted === 2, r.body);

// recorrência
r = await call('POST', '/transactions', { amount: 5000, type: 'receita', category_id: salario, description: 'Salário', date: '2026-08-05', repeat_months: 3 });
check('recorrência criada', r.body.transactions.length === 3, r.body);
check('receita fica numa conta', r.body.transactions.every((t) => t.account_id && !t.card_id), r.body.transactions[0]);

// validações
check('valor zero recusado', (await call('POST', '/transactions', { amount: 0, type: 'despesa', date: '2026-09-01' })).status === 400);
check('data inválida recusada', (await call('POST', '/transactions', { amount: 10, type: 'despesa', date: '2026-02-30' })).status === 400);
check('categoria de outro tipo recusada', (await call('POST', '/transactions', { amount: 10, type: 'despesa', category_id: salario, date: '2026-09-01' })).status === 400);
check('mês inválido recusado', (await call('GET', '/transactions?month=2026-13')).status === 400);

// dashboard
await call('POST', '/transactions', { amount: 200, type: 'despesa', category_id: alim, description: 'Mercado', date: '2026-09-10', payment_method: 'debito' });
await call('POST', '/transactions', { amount: 90, type: 'despesa', description: 'Sem categoria', date: '2026-09-11' });
const sum = (await call('GET', '/dashboard/summary?month=2026-09')).body;
check('resumo soma entradas e saídas', sum.entradasPeriodo === 5000 && sum.saidasPeriodo === 290, sum);
check('resumo traz mês anterior', sum.mesAnterior.entradas === 5000, sum.mesAnterior);
const dist = (await call('GET', '/dashboard/distribution?month=2026-09')).body;
check('distribuição inclui sem categoria', dist.some((d) => d.name === 'Sem categoria' && d.total === 90), dist);
const evo = (await call('GET', '/dashboard/evolution?from=2026-08&months=2')).body;
check('evolução mês a mês', evo.length === 2 && evo[1].saidas === 290, evo);

// orçamentos e metas
check('orçamento criado', (await call('POST', '/budgets', { category_id: alim, month_ref: '2026-09-01', limit_amount: 300 })).status === 201);
const bud = (await call('GET', '/budgets?month=2026-09')).body;
check('orçamento calcula o gasto', bud[0].spent === 200 && bud[0].percentageUsed === 67, bud[0]);
check('orçamento em receita recusado', (await call('POST', '/budgets', { category_id: salario, month_ref: '2026-09-01', limit_amount: 10 })).status === 400);
check('cópia de orçamentos', (await call('POST', '/budgets/copy', { from_month: '2026-09', to_month: '2026-10' })).body.copied === 1);
check('meta salva', (await call('POST', '/goals', { month_ref: '2026-09-01', savings_goal: 1000 })).status === 201);
check('meta zero encerra', (await call('POST', '/goals', { month_ref: '2026-09-01', savings_goal: 0 })).status === 201);

// total guardado
r = await call('PUT', '/savings', { manual_total: 10000 });
check('ajuste do total guardado', Math.abs(r.body.total - 10000) < 0.01, r.body);
check('resumo reflete o ajuste', Math.abs((await call('GET', '/dashboard/summary?month=2026-09')).body.saldoGeralAcumulado - 10000) < 0.01);

// categorias
r = await call('PUT', `/categories/${alim}`, { name: 'Comida', type: 'despesa', color: '#111111' });
check('categoria renomeada', r.status === 200 && r.body.name === 'Comida', r.body);
check('mudar tipo com lançamentos recusado', (await call('PUT', `/categories/${alim}`, { name: 'Comida', type: 'receita', color: '#111111' })).status === 400);
check('categoria excluída', (await call('DELETE', `/categories/${alim}`)).status === 204);
r = await call('GET', '/transactions?month=2026-09');
check('lançamentos da categoria excluída ficam sem categoria', r.body.every((t) => t.category_id !== alim), r.body.map((t) => t.category_id));

// perfil e erros
check('perfil atualizado', (await call('PUT', '/auth/me', { name: 'Novo Nome' })).body.name === 'Novo Nome');
check('senha errada recusada', (await call('PUT', '/auth/password', { current_password: 'x', new_password: 'nova-senha-456' })).status === 400);
r = await call('PUT', '/auth/password', { current_password: 'senha-teste-123', new_password: 'nova-senha-456' });
check('senha alterada devolve um token novo', r.status === 200 && typeof r.body.token === 'string', r.body);
check('rota inexistente em JSON', (await call('GET', '/nao-existe')).body.status === 'error');
check('keep-alive grava', (await call('GET', '/keep-alive?source=regressao')).body.pingCount >= 1);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
