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

const reg = await call('POST', '/auth/register', { name: 'Contas', email: `ct${Date.now()}@t.com`, password: 'senha-teste-123' });
token = reg.body.token;
const cats = (await call('GET', '/categories')).body;
const alim = cats.find((c) => c.name === 'Alimentação').id;
const salario = cats.find((c) => c.name === 'Salário').id;

// --- contas ---
let r = await call('GET', '/accounts');
check('usuário novo já tem conta padrão', r.body.length === 1 && r.body[0].name === 'Conta principal', r.body);
const principal = r.body[0].id;

r = await call('POST', '/accounts', { name: 'Nubank', kind: 'corrente', color: '#8B5CF6', initial_balance: 1000 });
check('cria conta com saldo inicial', r.status === 201, r.body);
const nubank = r.body.id;
r = await call('POST', '/accounts', { name: 'nubank', kind: 'corrente' });
check('nome repetido -> 409', r.status === 409, r.body);
r = await call('POST', '/accounts', { name: 'Carteira', kind: 'dinheiro', initial_balance: 150.5 });
const carteira = r.body.id;

r = await call('GET', '/accounts');
check('lista as três contas', r.body.length === 3, r.body.map((a) => a.name));
check('saldo começa igual ao saldo inicial', r.body.find((a) => a.id === nubank).balance === 1000, r.body);

// --- cartões ---
r = await call('POST', '/cards', { name: 'Nubank Roxinho', closing_day: 25, due_day: 5, limit_amount: 5000, payment_account_id: nubank });
check('cria cartão', r.status === 201, r.body);
const cartao = r.body.id;
r = await call('POST', '/cards', { name: 'Inválido', payment_account_id: 999999 });
check('conta de pagamento inexistente -> 404', r.status === 404, r.body);

// --- lançamentos em conta e cartão ---
const add = (body) => call('POST', '/transactions', body);
await add({ amount: 5000, type: 'receita', category_id: salario, description: 'Salário', date: '2026-09-05', account_id: nubank });
await add({ amount: 200, type: 'despesa', category_id: alim, description: 'Mercado', date: '2026-09-06', payment_method: 'debito', account_id: nubank });
await add({ amount: 80, type: 'despesa', category_id: alim, description: 'Feira', date: '2026-09-07', account_id: carteira });
r = await add({ amount: 300, type: 'despesa', category_id: alim, description: 'Restaurante', date: '2026-09-10', payment_method: 'credito', purchase_date: '2026-09-08', card_id: cartao });
check('despesa no crédito vai para o cartão', r.body.transactions[0].card_id === cartao && r.body.transactions[0].account_id === null, r.body.transactions[0]);

r = await call('GET', '/accounts');
check('saldo do Nubank desconta a despesa', r.body.find((a) => a.id === nubank).balance === 1000 + 5000 - 200, r.body.find((a) => a.id === nubank));
check('saldo da carteira', r.body.find((a) => a.id === carteira).balance === 150.5 - 80, r.body.find((a) => a.id === carteira));
check('compra no crédito não mexe no saldo da conta', r.body.find((a) => a.id === principal).balance === 0, r.body.find((a) => a.id === principal));

r = await call('GET', '/cards?month=2026-09');
check('fatura do mês soma as compras', r.body[0].billTotal === 300 && r.body[0].outstanding === 300, r.body[0]);
check('cartão traz fechamento e vencimento', r.body[0].closingDay === 25 && r.body[0].dueDay === 5, r.body[0]);
check('cartão sabe a conta que paga', r.body[0].paymentAccountName === 'Nubank', r.body[0]);

r = await call('GET', '/transactions?month=2026-09');
check('lançamento traz nome da conta', r.body.find((t) => t.description === 'Mercado').account_name === 'Nubank', r.body[0]);
check('lançamento traz nome do cartão', r.body.find((t) => t.description === 'Restaurante').card_name === 'Nubank Roxinho', r.body[0]);

// --- transferência entre contas ---
r = await call('POST', '/transfers', { from_account_id: nubank, to_account_id: carteira, amount: 500, date: '2026-09-12' });
check('cria transferência', r.status === 201 && r.body.transactions.length === 2, r.body);
const transferId = r.body.transferId;

r = await call('GET', '/accounts');
check('origem perde o valor', r.body.find((a) => a.id === nubank).balance === 1000 + 5000 - 200 - 500, r.body.find((a) => a.id === nubank));
check('destino ganha o valor', r.body.find((a) => a.id === carteira).balance === 150.5 - 80 + 500, r.body.find((a) => a.id === carteira));

let sum = (await call('GET', '/dashboard/summary?month=2026-09')).body;
check('transferência não vira receita', sum.entradasPeriodo === 5000, sum);
check('transferência não vira despesa', sum.saidasPeriodo === 200 + 80 + 300, sum);
let dist = (await call('GET', '/dashboard/distribution?month=2026-09')).body;
check('transferência fica fora da distribuição', dist.reduce((a, d) => a + d.total, 0) === 580, dist);
let evo = (await call('GET', '/dashboard/evolution?from=2026-09&months=1')).body;
check('transferência fica fora da evolução', evo[0].entradas === 5000 && evo[0].saidas === 580, evo);

r = await call('POST', '/transfers', { from_account_id: nubank, to_account_id: nubank, amount: 10, date: '2026-09-12' });
check('origem igual ao destino -> 400', r.status === 400, r.body);
r = await call('POST', '/transfers', { from_account_id: nubank, to_account_id: 999999, amount: 10, date: '2026-09-12' });
check('destino inexistente -> 404', r.status === 404, r.body);

// --- pagamento de fatura: conta -> cartão ---
r = await call('POST', '/transfers', { from_account_id: nubank, to_card_id: cartao, amount: 300, date: '2026-09-15' });
check('paga a fatura', r.status === 201, r.body);
r = await call('GET', '/cards');
check('saldo devedor zera após o pagamento', r.body[0].outstanding === 0, r.body[0]);
r = await call('GET', '/accounts');
check('pagamento sai do saldo da conta', r.body.find((a) => a.id === nubank).balance === 1000 + 5000 - 200 - 500 - 300, r.body.find((a) => a.id === nubank));
sum = (await call('GET', '/dashboard/summary?month=2026-09')).body;
check('pagamento de fatura não vira despesa nova', sum.saidasPeriodo === 580 && sum.entradasPeriodo === 5000, sum);

// Lançamento com data futura não pode mexer no saldo de hoje.
await add({ amount: 999, type: 'despesa', category_id: alim, description: 'Compra futura', date: '2027-01-10', account_id: carteira });
r = await call('GET', '/accounts');
check('lançamento futuro não afeta o saldo atual', r.body.find((a) => a.id === carteira).balance === 150.5 - 80 + 500, r.body.find((a) => a.id === carteira));

// --- proteções das transferências ---
const pernaTransferencia = (await call('GET', '/transactions?month=2026-09')).body.find((t) => t.transfer_id === transferId);
r = await call('PUT', `/transactions/${pernaTransferencia.id}`, { amount: 10, type: 'despesa', date: '2026-09-12' });
check('não deixa editar perna de transferência', r.status === 400, r.body);
r = await call('DELETE', `/transactions/${pernaTransferencia.id}`);
check('excluir uma perna apaga as duas', r.body.deleted === 2, r.body);
r = await call('DELETE', `/transfers/${transferId}`);
check('transferência já excluída -> 404', r.status === 404, r.body);

// --- exclusão e arquivamento ---
r = await call('DELETE', `/accounts/${nubank}`);
check('conta com lançamentos não é excluída', r.status === 409 && r.body.message.includes('Arquive'), r.body);
r = await call('PUT', `/accounts/${nubank}`, { name: 'Nubank', kind: 'corrente', initial_balance: 1000, archived: true });
check('conta pode ser arquivada', r.status === 200, r.body);
r = await call('DELETE', `/accounts/${principal}`);
check('conta sem lançamentos é excluída', r.status === 204, r.body);
r = await call('DELETE', `/cards/${cartao}`);
check('cartão com lançamentos não é excluído', r.status === 409, r.body);

// --- isolamento entre usuários ---
const t1 = token;
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `o${Date.now()}@t.com`, password: 'senha-teste-123' });
token = outro.body.token;
r = await call('PUT', `/accounts/${carteira}`, { name: 'Roubada', kind: 'corrente' });
check('não edita conta de outro usuário', r.status === 404, r.body);
r = await add({ amount: 10, type: 'despesa', date: '2026-09-10', account_id: carteira });
check('não lança na conta de outro usuário', r.status === 400 && r.body.message === 'Conta não encontrada', r.body);
r = await call('POST', '/transfers', { from_account_id: carteira, to_account_id: carteira, amount: 10, date: '2026-09-10' });
check('não transfere da conta de outro usuário', r.status === 400 || r.status === 404, r.body);
token = t1;

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
