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
const diaHoje = hoje.getDate();
const mes = (delta) => {
  const d = new Date(hoje.getFullYear(), hoje.getMonth() + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
// Mesma regra do backend: do dia de fechamento em diante, a fatura aberta é a do mês seguinte.
const faturaAberta = (fechamento) => (fechamento && diaHoje >= fechamento ? mes(1) : mes(0));

const reg = await call('POST', '/auth/register', { name: 'Fat', email: `fb${Date.now()}@t.com`, password: '123456' });
token = reg.body.token;
const conta = (await call('GET', '/accounts')).body[0].id;
// Fechamento dia 1: a fatura aberta é sempre a do mês seguinte, em qualquer dia do mês.
const inter = (await call('POST', '/cards', { name: 'Inter', limit_amount: 3900, closing_day: 1, due_day: 10 })).body.id;
const aberta = faturaAberta(1);

const gasto = (cardId, m, valor, desc) =>
  call('POST', '/transactions', {
    amount: valor, type: 'despesa', description: desc, date: `${m}-01`,
    payment_method: 'credito', purchase_date: `${m}-05`, card_id: cardId,
  });

// Faturas antigas (já pagas na vida real), a do mês e a que está aberta.
await gasto(inter, mes(-2), 707.88, 'Fatura de 2 meses atrás');
await gasto(inter, mes(-1), 1641.28, 'Fatura do mês passado');
await gasto(inter, mes(0), 1733.76, 'Fatura deste mês');
await gasto(inter, aberta, 200, 'Já caiu na fatura aberta');

const getCard = async (id) => (await call('GET', `/cards?month=${mes(0)}`)).body.find((c) => c.id === id);
const getBills = async (id) => (await call('GET', `/cards/${id}/bills`)).body;

// ---- fatura aberta x faturas fechadas ----
let card = await getCard(inter);
check('mês da fatura aberta segue o fechamento', card.openBillMonth === aberta, card);
check('fatura aberta traz só o que já caiu nela', card.openBillTotal === 200, card);
check('fechamento e vencimento da fatura aberta', card.openBillClosingDate === `${aberta}-01` && card.openBillDueDate === `${aberta}-10`, card);
const fechadas = 707.88 + 1641.28 + 1733.76;
check('dívida fechada soma as faturas que fecharam', card.closedDue === fechadas, card);
check('em aberto = fechadas + fatura aberta', card.outstanding === fechadas + 200, card);
check('conta quantas faturas fechadas estão sem baixa', card.closedUnpaidCount === 3, card);
check('nada de parcela futura ainda', card.futureInstallments === 0, card);

let bills = await getBills(inter);
check('lista de faturas vem da mais nova para a mais antiga', bills.bills[0].month === aberta, bills.bills.map((b) => b.month));
check('fatura do mês seguinte está aberta', bills.bills[0].status === 'aberta', bills.bills[0]);
check('faturas anteriores estão fechadas', bills.bills.slice(1, 4).every((b) => b.status === 'fechada'), bills.bills);
const mesPassado = bills.bills.find((b) => b.month === mes(-1));
check('total da fatura do mês passado', mesPassado.total === 1641.28, mesPassado);
check('restante é o total quando não houve pagamento', mesPassado.remaining === 1641.28, mesPassado);
check('vencimento da fatura do mês passado', mesPassado.dueDate === `${mes(-1)}-10`, mesPassado);
check('conta os itens da fatura', mesPassado.items === 1, mesPassado);

// ---- baixa sem mexer em conta (pago fora do app) ----
let r = await call('POST', `/cards/${inter}/bills/${mes(-1)}/pay`, { kind: 'externo' });
check('baixa externa aceita e usa o valor da fatura', r.status === 201 && r.body.amount === 1641.28, r.body);
card = await getCard(inter);
check('dívida fechada cai o valor da fatura paga', card.closedDue === Math.round((fechadas - 1641.28) * 100) / 100, card);
check('uma fatura fechada a menos sem baixa', card.closedUnpaidCount === 2, card);
bills = await getBills(inter);
check('fatura aparece como paga', bills.bills.find((b) => b.month === mes(-1)).status === 'paga', bills.bills);
check('guarda como foi a baixa', bills.bills.find((b) => b.month === mes(-1)).payment.kind === 'externo', bills.bills);

r = await call('POST', `/cards/${inter}/bills/${mes(-1)}/pay`, { kind: 'externo' });
check('não dá baixa duas vezes na mesma fatura', r.status === 409, r.body);

// ---- baixa pagando de uma conta ----
const saldoAntes = (await call('GET', '/accounts')).body.find((a) => a.id === conta).balance;
r = await call('POST', `/cards/${inter}/bills/${mes(0)}/pay`, { kind: 'transferencia', from_account_id: conta });
check('baixa com pagamento cria a transferência', r.status === 201 && !!r.body.transferId, r.body);
const saldoDepois = (await call('GET', '/accounts')).body.find((a) => a.id === conta).balance;
check('o dinheiro sai da conta escolhida', Math.round((saldoAntes - saldoDepois) * 100) / 100 === 1733.76, { saldoAntes, saldoDepois });
card = await getCard(inter);
check('dívida fechada zera sem descontar duas vezes', card.closedDue === 707.88, card);
check('em aberto fica só com a fatura aberta e o que falta', card.outstanding === 907.88, card);
bills = await getBills(inter);
const paga = bills.bills.find((b) => b.month === mes(0));
check('fatura paga por transferência mostra o pagamento lançado', paga.credits === 1733.76 && paga.payment.kind === 'transferencia', paga);
check('pagamento da fatura não conta como receita do mês', (await call('GET', `/dashboard/summary?month=${mes(0)}`)).body.entradasPeriodo === 0, null);

// ---- desfazer a baixa ----
r = await call('DELETE', `/cards/${inter}/bills/${mes(0)}/pay`);
check('desfaz a baixa e remove as duas pontas da transferência', r.status === 200 && r.body.transferRemoved === 2, r.body);
card = await getCard(inter);
check('dívida volta ao que era', card.closedDue === Math.round((fechadas - 1641.28) * 100) / 100, card);
const saldoVolta = (await call('GET', '/accounts')).body.find((a) => a.id === conta).balance;
check('saldo da conta volta ao que era', saldoVolta === saldoAntes, { saldoAntes, saldoVolta });
r = await call('DELETE', `/cards/${inter}/bills/${mes(0)}/pay`);
check('desfazer fatura sem baixa -> 404', r.status === 404, r.body);

// ---- baixa em tudo que já fechou, com ajuste manual antigo ----
await call('PUT', `/cards/${inter}/outstanding`, { current_outstanding: 2641.64 });
r = await call('POST', `/cards/${inter}/bills/settle-past`);
check('dá baixa nas faturas fechadas que faltavam', r.status === 200 && r.body.settled === 2, r.body);
card = await getCard(inter);
check('ajuste manual é zerado junto', card.outstandingAdjustment === 0, card);
check('não sobra dívida de fatura fechada', card.closedDue === 0, card);
check('em aberto passa a ser só a fatura aberta', card.outstanding === 200, card);
check('nenhuma fatura fechada sem baixa', card.closedUnpaidCount === 0, card);
bills = await getBills(inter);
check('todas as anteriores ficam como pagas', bills.bills.filter((b) => b.status === 'fechada').length === 0, bills.bills);

// ---- compra nova na fatura aberta continua somando ----
await gasto(inter, aberta, 50, 'Compra nova');
card = await getCard(inter);
check('compra nova entra na fatura aberta', card.openBillTotal === 250 && card.outstanding === 250, card);

// ---- cartão sem dia de fechamento: fatura aberta é a do mês corrente ----
const simples = (await call('POST', '/cards', { name: 'Sem datas' })).body.id;
await gasto(simples, mes(0), 80, 'Compra');
card = await getCard(simples);
check('sem fechamento, a fatura aberta é a do mês', card.openBillMonth === mes(0), card);
check('sem fechamento, a compra do mês fica na fatura aberta', card.openBillTotal === 80 && card.closedDue === 0, card);

// ---- o caso de mover uma compra antiga para outro cartão ----
const nubank = (await call('POST', '/cards', { name: 'Nubank', closing_day: 1, due_day: 10 })).body.id;
const antiga = (await call('GET', `/transactions?month=${mes(-2)}`)).body[0];
r = await call('POST', '/transactions/move', { ids: [antiga.id], card_id: nubank });
check('move a compra antiga para o Nubank', r.body.moved === 1, r.body);
card = await getCard(nubank);
check('a compra antiga aparece como fatura fechada a pagar', card.closedDue === 707.88 && card.closedUnpaidCount === 1, card);
r = await call('POST', `/cards/${nubank}/bills/settle-past`);
check('baixa nas anteriores resolve o Nubank', r.status === 200, r.body);
card = await getCard(nubank);
check('Nubank fica sem dívida', card.outstanding === 0, card);
card = await getCard(inter);
check('e a dívida também não volta no Inter', card.closedDue === 0, card);

// ---- compra lançada numa fatura que já foi paga ----
await gasto(nubank, mes(-2), 120, 'Compra que faltava');
card = await getCard(nubank);
check('compra nova em fatura paga volta a ser dívida', card.closedDue === 120, card);
bills = await getBills(nubank);
check('a fatura paga mostra o que entrou depois', bills.bills.find((b) => b.month === mes(-2)).remaining === 120, bills.bills);
r = await call('POST', `/cards/${nubank}/bills/settle-past`, {});
check('segunda baixa resolve a diferença', r.status === 200, r.body);
card = await getCard(nubank);
check('e o cartão volta a ficar sem dívida', card.closedDue === 0, card);

// ---- validações ----
r = await call('POST', `/cards/${inter}/bills/2026-13/pay`, {});
check('mês inválido -> 400', r.status === 400, r.body);
r = await call('POST', `/cards/${inter}/bills/${mes(2)}/pay`, {});
check('fatura que ainda não abriu -> 400', r.status === 400, r.body);
r = await call('POST', `/cards/${inter}/bills/${aberta}/pay`, { kind: 'transferencia', from_account_id: 999999 });
check('conta inexistente -> 404', r.status === 404, r.body);
r = await call('POST', `/cards/${inter}/bills/${aberta}/pay`, { kind: 'transferencia' });
check('transferência sem conta -> 400', r.status === 400, r.body);
r = await call('POST', `/cards/${inter}/bills/${aberta}/pay`, { kind: 'externo', date: '2026-02-31' });
check('data inválida -> 400', r.status === 400, r.body);
r = await call('GET', `/cards/999999/bills`);
check('faturas de cartão inexistente -> 404', r.status === 404, r.body);

const t1 = token;
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `ob${Date.now()}@t.com`, password: '123456' });
token = outro.body.token;
r = await call('GET', `/cards/${inter}/bills`);
check('não lê faturas de cartão de outro usuário', r.status === 404, r.body);
r = await call('POST', `/cards/${inter}/bills/${mes(-1)}/pay`, { kind: 'externo' });
check('não dá baixa em cartão de outro usuário', r.status === 404, r.body);
r = await call('POST', `/cards/${inter}/bills/settle-past`);
check('não dá baixa em lote em cartão de outro usuário', r.status === 404, r.body);
token = t1;

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
