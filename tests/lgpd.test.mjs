// Início do "Total guardado" por usuário e exclusão de conta (LGPD).
const B = process.env.API_URL ?? 'http://localhost:3334';
let fails = 0;
const call = async (method, path, body, token) => {
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
const SENHA = 'senha-teste-123';
const novoUsuario = async (prefixo) => {
  const email = `${prefixo}${Date.now()}${Math.floor(Math.random() * 1e5)}@t.com`;
  const r = await call('POST', '/auth/register', { name: prefixo, email, password: SENHA });
  return { email, token: r.body.token };
};
const resumo = async (token) => (await call('GET', '/dashboard/summary?month=2026-09', null, token)).body;

// ================= Total guardado =================
const ana = await novoUsuario('ana');
let s = await resumo(ana.token);
check('sem lançamentos: total zero', s.saldoGeralAcumulado === 0, s);
check('sem lançamentos: sem data de início', s.savingsStartDate === null && s.savingsStartChosen === false, s);

const conta = (await call('GET', '/accounts', null, ana.token)).body[0].id;
const lancar = (valor, tipo, data) => call('POST', '/transactions', {
  amount: valor, type: tipo, date: data, payment_method: 'dinheiro', account_id: conta, description: 'Teste',
}, ana.token);
await lancar(1000, 'receita', '2026-03-10');
await lancar(200, 'despesa', '2026-09-10');

s = await resumo(ana.token);
check('conta desde o primeiro lançamento, mesmo antes de agosto/2026', s.saldoGeralAcumulado === 800, s);
check('início é o dia do primeiro lançamento', s.savingsStartDate === '2026-03-10' && s.savingsStartChosen === false, s);

let r = await call('PUT', '/savings', { start_date: '2026-06-01' }, ana.token);
check('escolher a data de início', r.status === 200 && r.body.total === -200, r.body);
s = await resumo(ana.token);
check('o resumo passa a usar a data escolhida', s.savingsStartDate === '2026-06-01' && s.savingsStartChosen === true && s.saldoGeralAcumulado === -200, s);

r = await call('PUT', '/savings', { manual_total: 500 }, ana.token);
check('ajustar o valor mantém a data escolhida', r.status === 200 && r.body.total === 500 && r.body.savingsAdjustment === 700, r.body);

r = await call('PUT', '/savings', { start_date: null }, ana.token);
check('voltar para "desde o primeiro lançamento" mantém o ajuste', r.body.total === 1500, r.body);
s = await resumo(ana.token);
check('e o resumo volta a mostrar o primeiro lançamento', s.savingsStartDate === '2026-03-10' && s.savingsStartChosen === false, s);

r = await call('PUT', '/savings', { start_date: '2026-02-31' }, ana.token);
check('data inválida -> 400', r.status === 400, r.body);
r = await call('PUT', '/savings', {}, ana.token);
check('sem nenhum campo -> 400', r.status === 400, r.body);

// ================= Exclusão de conta =================
// Quem vai sair tem um pouco de tudo, para a exclusão passar por todas as tabelas.
const bia = await novoUsuario('bia');
const biaConta = (await call('GET', '/accounts', null, bia.token)).body[0].id;
const biaCartao = (await call('POST', '/cards', { name: 'Cartão', closing_day: 1, due_day: 10, payment_account_id: biaConta }, bia.token)).body.id;
const biaCategoria = (await call('GET', '/categories', null, bia.token)).body.find((c) => c.type === 'despesa').id;
await call('POST', '/transactions', { amount: 50, type: 'despesa', date: '2026-09-05', payment_method: 'dinheiro', account_id: biaConta, category_id: biaCategoria }, bia.token);
await call('POST', '/transactions', { amount: 90, type: 'despesa', date: '2026-09-01', payment_method: 'credito', purchase_date: '2026-08-20', card_id: biaCartao, category_id: biaCategoria }, bia.token);
await call('POST', `/cards/${biaCartao}/bills/2026-09/pay`, { kind: 'transferencia', from_account_id: biaConta }, bia.token);
await call('POST', '/budgets', { category_id: biaCategoria, month_ref: '2026-09', limit_amount: 300 }, bia.token);
await call('POST', '/goals', { month_ref: '2026-09-01', savings_goal: 100 }, bia.token);
await call('POST', '/auth/login', { email: bia.email, password: 'senha-errada-1' });

// e outra pessoa, que não pode ser afetada
const caio = await novoUsuario('caio');
const caioConta = (await call('GET', '/accounts', null, caio.token)).body[0].id;
await call('POST', '/transactions', { amount: 77, type: 'despesa', date: '2026-09-05', payment_method: 'dinheiro', account_id: caioConta }, caio.token);

r = await call('DELETE', '/auth/me', {}, bia.token);
check('excluir sem senha -> 400', r.status === 400, r.body);
r = await call('DELETE', '/auth/me', { password: 'senha-errada' }, bia.token);
check('excluir com senha errada -> 400', r.status === 400, r.body);
// 50 na conta, 90 no cartão e as duas pontas do pagamento da fatura (lançado com a data de hoje)
const antes = (await call('GET', '/transactions', null, bia.token)).body.length;
check('com a senha errada nada é apagado', antes === 4, antes);

r = await call('DELETE', '/auth/me', { password: SENHA }, bia.token);
check('excluir com a senha certa', r.status === 204, r.body);
check('a sessão deixa de valer', (await call('GET', '/accounts', null, bia.token)).status === 401, null);
check('não dá mais para entrar', (await call('POST', '/auth/login', { email: bia.email, password: SENHA })).status === 401, null);

r = await call('POST', '/auth/register', { name: 'Bia de novo', email: bia.email, password: SENHA });
check('o mesmo e-mail pode criar uma conta nova', r.status === 201, r.body);
const nova = r.body.token;
check('a conta nova nasce vazia, sem nada da antiga',
  (await call('GET', '/transactions?month=2026-09', null, nova)).body.length === 0 &&
  (await call('GET', '/cards', null, nova)).body.length === 0 &&
  (await call('GET', '/budgets?month=2026-09', null, nova)).body.length === 0, null);
check('a conta nova tem só as categorias padrão', (await call('GET', '/categories', null, nova)).body.length === 11, null);

r = await call('GET', '/transactions?month=2026-09', null, caio.token);
check('os dados de outra pessoa ficam intactos', r.status === 200 && r.body.length === 1 && Number(r.body[0].amount) === 77, r.body);

check('sem token não exclui nada', (await call('DELETE', '/auth/me', { password: SENHA })).status === 401, null);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
