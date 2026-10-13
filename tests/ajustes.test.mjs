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
const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
const mesSeguinte = () => { const d = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

const reg = await call('POST', '/auth/register', { name: 'Aju', email: `aj${Date.now()}@t.com`, password: 'senha-teste-123' });
token = reg.body.token;
const principal = (await call('GET', '/accounts')).body[0].id;
const inter = (await call('POST', '/accounts', { name: 'Inter', kind: 'corrente' })).body.id;
const card = (await call('POST', '/cards', { name: 'Nubank Roxinho' })).body.id;

// ---- 1) ajuste de saldo ----
await call('POST', '/transactions', { amount: 1000, type: 'receita', date: `${mesAtual}-02`, account_id: principal });
await call('POST', '/transactions', { amount: 400, type: 'despesa', date: `${mesAtual}-03`, account_id: principal });
let r = await call('GET', '/accounts');
check('saldo parte de zero', r.body.find((a) => a.id === principal).balance === 600, r.body);

r = await call('PUT', `/accounts/${principal}/balance`, { current_balance: 5000 });
check('ajuste responde com o saldo pedido', r.status === 200 && r.body.balance === 5000, r.body);
check('saldo inicial deduzido do movimento', r.body.initialBalance === 4400 && r.body.movement === 600, r.body);
r = await call('GET', '/accounts');
check('saldo passa a bater com o informado', r.body.find((a) => a.id === principal).balance === 5000, r.body);

// novos lançamentos continuam somando a partir do saldo ajustado
await call('POST', '/transactions', { amount: 250, type: 'despesa', date: `${mesAtual}-04`, account_id: principal });
r = await call('GET', '/accounts');
check('lançamento posterior desconta do saldo ajustado', r.body.find((a) => a.id === principal).balance === 4750, r.body);

r = await call('PUT', `/accounts/${principal}/balance`, { current_balance: -120.5 });
check('aceita saldo negativo', r.status === 200 && r.body.balance === -120.5, r.body);
r = await call('PUT', `/accounts/${principal}/balance`, {});
check('saldo ausente -> 400', r.status === 400, r.body);
r = await call('PUT', `/accounts/999999/balance`, { current_balance: 10 });
check('conta inexistente -> 404', r.status === 404, r.body);
await call('PUT', `/accounts/${principal}/balance`, { current_balance: 4750 });

// ---- 2) cartão: em aberto x parcelas futuras ----
await call('POST', '/transactions', {
  amount: 1200, type: 'despesa', date: `${mesAtual}-01`, payment_method: 'credito',
  purchase_date: `${mesAtual}-01`, card_id: card, is_installment: true, installments: 4,
});
r = await call('GET', `/cards?month=${mesAtual}`);
let c = r.body[0];
check('fatura do mês é só a primeira parcela', c.billTotal === 300, c);
check('em aberto não inclui parcelas futuras', c.outstanding === 300, c);
check('parcelas futuras somadas à parte', c.futureInstallments === 900, c);

// pagamento da fatura abate o que está em aberto
await call('POST', '/transfers', { from_account_id: principal, to_card_id: card, amount: 300, date: `${mesAtual}-05` });
r = await call('GET', `/cards?month=${mesAtual}`);
c = r.body[0];
check('pagamento zera o em aberto', c.outstanding === 0, c);
check('parcelas futuras seguem iguais', c.futureInstallments === 900, c);
check('fatura do mês não muda com o pagamento', c.billTotal === 300, c);
r = await call('GET', `/cards?month=${mesSeguinte()}`);
check('fatura de outro mês é consultável', r.body[0].billTotal === 300, r.body[0]);

// ---- 3) mover lançamentos em lote ----
const doPrincipal = (await call('GET', `/transactions?month=${mesAtual}`)).body
  .filter((t) => t.account_id === principal && !t.transfer_id)
  .map((t) => t.id);
r = await call('POST', '/transactions/move', { ids: doPrincipal, account_id: inter });
check('move lançamentos de conta', r.status === 200 && r.body.moved === doPrincipal.length, r.body);
let lista = (await call('GET', `/transactions?month=${mesAtual}`)).body;
check('lançamentos aparecem na conta nova', lista.filter((t) => t.account_id === inter).length === doPrincipal.length, lista.map((t) => t.account_name));
check('nome da conta vem atualizado', lista.find((t) => t.id === doPrincipal[0]).account_name === 'Inter', lista[0]);

const doCartao = lista.filter((t) => t.card_id).map((t) => t.id);
r = await call('POST', '/transactions/move', { ids: doCartao, account_id: inter });
check('lançamento de cartão não vai para conta', r.body.moved === 0 && r.body.skipped === doCartao.length, r.body);
const card2 = (await call('POST', '/cards', { name: 'Inter Gold' })).body.id;
r = await call('POST', '/transactions/move', { ids: doCartao, card_id: card2 });
check('move entre cartões (inclui a perna do pagamento)', r.body.moved === doCartao.length && r.body.skipped === 0, r.body);
r = await call('GET', `/cards?month=${mesAtual}`);
check('fatura segue o cartão novo', r.body.find((x) => x.id === card2).billTotal === 300, r.body);

const pernaDaConta = (await call('GET', `/transactions?month=${mesAtual}`)).body.find(
  (t) => t.transfer_id && t.account_id,
);
r = await call('POST', '/transactions/move', { ids: [pernaDaConta.id], card_id: card2 });
check('lançamento que está em conta não vai para cartão', r.body.moved === 0, r.body);

r = await call('POST', '/transactions/move', { ids: [], account_id: inter });
check('lista vazia -> 400', r.status === 400, r.body);
r = await call('POST', '/transactions/move', { ids: [1], account_id: inter, card_id: card2 });
check('dois destinos -> 400', r.status === 400, r.body);
r = await call('POST', '/transactions/move', { ids: [1], account_id: 999999 });
check('destino inexistente -> 404', r.status === 404, r.body);

const t1 = token;
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `o${Date.now()}@t.com`, password: 'senha-teste-123' });
token = outro.body.token;
const contaOutro = (await call('GET', '/accounts')).body[0].id;
r = await call('POST', '/transactions/move', { ids: doPrincipal, account_id: contaOutro });
check('não move lançamento de outro usuário', r.body.moved === 0, r.body);
r = await call('PUT', `/accounts/${inter}/balance`, { current_balance: 1 });
check('não ajusta conta de outro usuário', r.status === 404, r.body);
token = t1;

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
