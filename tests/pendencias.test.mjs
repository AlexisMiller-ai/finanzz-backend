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
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dia = (delta) => iso(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + delta));
const mes = (delta) => {
  const d = new Date(hoje.getFullYear(), hoje.getMonth() + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const reg = await call('POST', '/auth/register', { name: 'Pend', email: `pd${Date.now()}@t.com`, password: 'senha-teste-123' });
token = reg.body.token;
const conta = (await call('GET', '/accounts')).body[0].id;
await call('PUT', `/accounts/${conta}/balance`, { current_balance: 1000 });

const saldo = async () => (await call('GET', '/accounts')).body.find((a) => a.id === conta).balance;
const guardado = async () => (await call('GET', `/dashboard/summary?month=${mes(0)}`)).body.saldoGeralAcumulado;

// ---- lançamento pendente fica fora do saldo ----
let r = await call('POST', '/transactions', {
  amount: 200, type: 'despesa', description: 'Conta de luz', date: dia(-2),
  payment_method: 'dinheiro', account_id: conta, settled: false,
});
check('cria despesa pendente', r.status === 201, r.body);
const luz = (r.body.transactions ?? [r.body])[0].id;
check('lançamento nasce pendente', (r.body.transactions ?? [r.body])[0].settled === false, r.body);
check('vencida não sai do saldo', (await saldo()) === 1000, await saldo());

const guardadoAntes = await guardado();
r = await call('POST', '/transactions', {
  amount: 500, type: 'receita', description: 'Freela a receber', date: dia(1),
  payment_method: 'dinheiro', account_id: conta, settled: false,
});
const freela = (r.body.transactions ?? [r.body])[0].id;
check('receita a receber não entra no total guardado', (await guardado()) === guardadoAntes, await guardado());

// ---- baixa ----
r = await call('PUT', `/transactions/${luz}/settle`, { settled: true, date: dia(0) });
check('baixa marca como paga', r.status === 200 && r.body.settled === true, r.body);
check('depois da baixa sai do saldo', (await saldo()) === 800, await saldo());
r = await call('PUT', `/transactions/${luz}/settle`, { settled: false });
check('dá para voltar a pendente', r.body.settled === false, r.body);
check('e o saldo volta', (await saldo()) === 1000, await saldo());
check('data do pagamento some ao voltar', r.body.settled_at === null, r.body);

// ---- lançamento comum continua efetivado por padrão ----
r = await call('POST', '/transactions', {
  amount: 50, type: 'despesa', description: 'Mercado', date: dia(0),
  payment_method: 'dinheiro', account_id: conta,
});
check('sem informar nada, nasce efetivado', (r.body.transactions ?? [r.body])[0].settled === true, r.body);
check('e entra no saldo na hora', (await saldo()) === 950, await saldo());

// ---- filtro por situação ----
r = await call('GET', `/transactions?status=pendente`);
check('filtra só os pendentes', r.body.length === 2 && r.body.every((t) => !t.settled), r.body.length);
r = await call('GET', `/transactions?status=efetivado`);
check('filtra só os efetivados', r.body.every((t) => t.settled), r.body.length);
r = await call('GET', `/transactions?status=qualquer`);
check('status inválido -> 400', r.status === 400, r.body);

// ---- parcelas e repetições nascem pendentes a partir da segunda ----
r = await call('POST', '/transactions', {
  amount: 300, type: 'despesa', description: 'Curso', date: dia(0),
  payment_method: 'dinheiro', account_id: conta, is_installment: true, installments: 3,
});
const parcelas = r.body.transactions;
check('primeira parcela sai efetivada', parcelas[0].settled === true, parcelas[0]);
check('as próximas ficam a pagar', parcelas.slice(1).every((p) => p.settled === false), parcelas);
check('só a primeira parcela mexe no saldo', (await saldo()) === 850, await saldo());

r = await call('POST', '/transactions', {
  amount: 80, type: 'despesa', description: 'Academia', date: dia(0),
  payment_method: 'dinheiro', account_id: conta, repeat_months: 3,
});
check('repetição: a primeira efetivada, as outras a pagar',
  r.body.transactions[0].settled === true && r.body.transactions.slice(1).every((t) => !t.settled), r.body.transactions);

// ---- cartão não tem pendência por lançamento ----
const cartao = (await call('POST', '/cards', { name: 'Inter', closing_day: 1, due_day: 10 })).body.id;
r = await call('POST', '/transactions', {
  amount: 120, type: 'despesa', description: 'Compra no crédito', date: `${mes(0)}-01`,
  payment_method: 'credito', purchase_date: dia(-1), card_id: cartao, settled: false,
});
const compraCartao = (r.body.transactions ?? [r.body])[0];
check('compra no cartão ignora o pedido de pendência', compraCartao.settled === true, compraCartao);
r = await call('PUT', `/transactions/${compraCartao.id}/settle`, { settled: false });
check('baixa em compra de cartão -> 400', r.status === 400, r.body);

r = await call('POST', '/transactions', {
  amount: 500, type: 'despesa', description: 'Parcelado no cartão', date: `${mes(0)}-01`,
  payment_method: 'credito', purchase_date: dia(-1), card_id: cartao, is_installment: true, installments: 4,
});
check('parcelamento no cartão não vira pendência', r.status === 201 && r.body.transactions.every((t) => t.settled), r.body);

// ---- transferência não tem pendência ----
const outra = (await call('POST', '/accounts', { name: 'Poupança', kind: 'poupanca' })).body.id;
r = await call('POST', '/transfers', { from_account_id: conta, to_account_id: outra, amount: 10, date: dia(0) });
const pernaId = r.body.transactions[0].id;
r = await call('PUT', `/transactions/${pernaId}/settle`, { settled: false });
check('baixa em transferência -> 400', r.status === 400, r.body);

// ---- o que vence nos próximos dias ----
await call('POST', '/transactions', {
  amount: 90, type: 'despesa', description: 'Internet', date: dia(3),
  payment_method: 'dinheiro', account_id: conta, settled: false,
});
await call('POST', '/transactions', {
  amount: 999, type: 'despesa', description: 'Lá longe', date: dia(40),
  payment_method: 'dinheiro', account_id: conta, settled: false,
});

r = await call('GET', '/transactions/upcoming?days=7');
const { vencidos, proximos, totais, aindaMaisTarde } = r.body;
check('lista o que já venceu', vencidos.some((i) => i.descricao === 'Conta de luz' && i.emDias === -2), vencidos);
check('lista o que vence nos próximos dias', proximos.some((i) => i.descricao === 'Internet' && i.emDias === 3), proximos);
check('a receber também aparece', proximos.some((i) => i.descricao === 'Freela a receber' && i.movimento === 'receita'), proximos);
check('o que está longe fica de fora, mas é contado', aindaMaisTarde >= 1 && !proximos.some((i) => i.descricao === 'Lá longe'), { aindaMaisTarde, proximos });
// Só os lançamentos: faturas fechadas podem ou não estar vencidas, conforme o dia de hoje.
const vencidoEmLancamentos = vencidos
  .filter((i) => i.tipo === 'lancamento' && i.movimento === 'despesa')
  .reduce((soma, i) => soma + i.valor, 0);
check('soma o que está vencido a pagar', vencidoEmLancamentos === 200, { vencidoEmLancamentos, totais });
check('soma o que vence a receber', totais.aReceberProximos === 500, totais);

// fatura fechada sem baixa entra na lista
await call('POST', '/transactions', {
  amount: 400, type: 'despesa', description: 'Compras do mês passado', date: `${mes(-1)}-01`,
  payment_method: 'credito', purchase_date: `${mes(-1)}-10`, card_id: cartao,
});
r = await call('GET', '/transactions/upcoming?days=7');
const fatura = [...r.body.vencidos, ...r.body.proximos].find((i) => i.tipo === 'fatura');
check('fatura fechada sem baixa aparece como conta a pagar', !!fatura && fatura.valor === 400, r.body);
check('fatura usa o vencimento do cartão', fatura?.vencimento === `${mes(-1)}-10`, fatura);

await call('POST', `/cards/${cartao}/bills/${mes(-1)}/pay`, { kind: 'externo' });
r = await call('GET', '/transactions/upcoming?days=7');
check('depois da baixa, aquela fatura sai da lista',
  ![...r.body.vencidos, ...r.body.proximos].some((i) => i.mes === mes(-1)), r.body);
check('mas a fatura do mês que fechou depois continua a pagar',
  [...r.body.vencidos, ...r.body.proximos].some((i) => i.tipo === 'fatura' && i.mes === mes(0)), r.body);

r = await call('GET', '/transactions/upcoming?days=400');
check('days fora do limite -> 400', r.status === 400, r.body);

// ---- edição mantém/muda a situação ----
r = await call('PUT', `/transactions/${freela}`, {
  amount: 500, type: 'receita', description: 'Freela a receber', date: dia(1),
  payment_method: 'dinheiro', account_id: conta, settled: true,
});
check('editar pode marcar como recebido', r.body.transactions[0].settled === true, r.body);
r = await call('GET', `/transactions?status=pendente`);
check('e ele sai da lista de pendentes', !r.body.some((t) => t.id === freela), r.body.map((t) => t.id));

// ---- isolamento por usuário ----
const t1 = token;
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `op${Date.now()}@t.com`, password: 'senha-teste-123' });
token = outro.body.token;
r = await call('PUT', `/transactions/${luz}/settle`, { settled: true });
check('não dá baixa em lançamento de outro usuário', r.status === 404, r.body);
r = await call('GET', '/transactions/upcoming');
check('cada um vê só as próprias contas', r.body.vencidos.length === 0 && r.body.proximos.length === 0, r.body);
token = t1;

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
