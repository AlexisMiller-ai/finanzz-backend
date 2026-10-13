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
const atual = mes(0);

const reg = await call('POST', '/auth/register', { name: 'Fat', email: `ft${Date.now()}@t.com`, password: '123456' });
token = reg.body.token;
const conta = (await call('GET', '/accounts')).body[0].id;
const inter = (await call('POST', '/cards', { name: 'Inter', limit_amount: 3900 })).body.id;
const nubank = (await call('POST', '/cards', { name: 'Nubank', limit_amount: 9800 })).body.id;

// cenário do usuário: faturas antigas já pagas na vida real, nunca registradas
const gasto = (cardId, m, valor, desc) =>
  call('POST', '/transactions', {
    amount: valor, type: 'despesa', description: desc, date: `${m}-01`,
    payment_method: 'credito', purchase_date: `${m}-05`, card_id: cardId,
  });
await gasto(inter, mes(-2), 700, 'Compras de 2 meses atrás');
await gasto(inter, mes(-1), 1600, 'Compras do mês passado');
await gasto(inter, atual, 1733.76, 'Compras deste mês');

let card = (await call('GET', `/cards?month=${atual}`)).body.find((c) => c.id === inter);
check('em aberto soma faturas antigas não pagas', card.outstanding === 4033.76, card);
check('fatura do mês é só a deste mês', card.billTotal === 1733.76, card);

// ---- ajuste da fatura ----
let r = await call('PUT', `/cards/${inter}/outstanding`, { current_outstanding: 1733.76 });
check('ajuste aceita o valor real', r.status === 200 && r.body.outstanding === 1733.76, r.body);
check('guarda a diferença como ajuste', r.body.outstandingAdjustment === -2300, r.body);
card = (await call('GET', `/cards?month=${atual}`)).body.find((c) => c.id === inter);
check('em aberto passa a mostrar só a fatura atual', card.outstanding === 1733.76, card);
check('ajuste é devolvido na listagem', card.outstandingAdjustment === -2300, card);
check('fatura do mês não muda com o ajuste', card.billTotal === 1733.76, card);

// novas compras continuam somando por cima do ajuste
await gasto(inter, atual, 100, 'Compra nova');
card = (await call('GET', `/cards?month=${atual}`)).body.find((c) => c.id === inter);
check('compra nova soma ao em aberto ajustado', card.outstanding === 1833.76, card);

// pagamento da fatura abate normalmente
await call('POST', '/transfers', { from_account_id: conta, to_card_id: inter, amount: 1833.76, date: `${atual}-10` });
card = (await call('GET', `/cards?month=${atual}`)).body.find((c) => c.id === inter);
check('pagamento zera mesmo com ajuste aplicado', card.outstanding === 0, card);

// ---- o caso que motivou tudo: mover compra antiga para outro cartão ----
const antiga = (await call('GET', `/transactions?month=${mes(-1)}`)).body[0];
r = await call('POST', '/transactions/move', { ids: [antiga.id], card_id: nubank });
check('move a compra antiga para o Nubank', r.body.moved === 1, r.body);
let nu = (await call('GET', `/cards?month=${atual}`)).body.find((c) => c.id === nubank);
check('compra antiga aparece em aberto no Nubank', nu.outstanding === 1600, nu);
r = await call('PUT', `/cards/${nubank}/outstanding`, { current_outstanding: 0 });
check('ajuste zera o Nubank', r.status === 200, r.body);
nu = (await call('GET', `/cards?month=${atual}`)).body.find((c) => c.id === nubank);
check('Nubank fica sem dívida', nu.outstanding === 0, nu);

// ---- validações ----
r = await call('PUT', `/cards/${inter}/outstanding`, {});
check('valor ausente -> 400', r.status === 400, r.body);
r = await call('PUT', `/cards/${inter}/outstanding`, { current_outstanding: -50 });
check('valor negativo -> 400', r.status === 400, r.body);
r = await call('PUT', `/cards/999999/outstanding`, { current_outstanding: 10 });
check('cartão inexistente -> 404', r.status === 404, r.body);

const t1 = token;
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `o${Date.now()}@t.com`, password: '123456' });
token = outro.body.token;
r = await call('PUT', `/cards/${inter}/outstanding`, { current_outstanding: 0 });
check('não ajusta cartão de outro usuário', r.status === 404, r.body);
token = t1;

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
