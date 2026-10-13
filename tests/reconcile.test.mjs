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

const reg = await call('POST', '/auth/register', { name: 'Conc', email: `conc${Date.now()}@t.com`, password: 'senha-teste-123' });
token = reg.body.token;
const cats = (await call('GET', '/categories')).body;
const alim = cats.find((c) => c.name === 'Alimentação').id;
const transp = cats.find((c) => c.name === 'Transporte').id;

// O usuário lança na hora, no crédito (fatura de outubro)
const manual = async (desc, valor, compra, categoria) =>
  (await call('POST', '/transactions', {
    amount: valor, type: 'despesa', category_id: categoria, description: desc,
    date: '2026-10-01', purchase_date: compra, payment_method: 'credito',
  })).body.transactions[0];

const ifood = await manual('iFood', 78.5, '2026-09-03', alim);
const uber = await manual('Uber pro trabalho', 24.9, '2026-09-05', transp);
const mercado = await manual('Mercado', 50, '2026-09-08', alim); // digitou 50, saiu 52,90
const almoco = await manual('Almoço com a equipe', 120, '2026-09-20', alim); // longe da data do arquivo

// A fatura chega com as descrições do banco
const fatura = [
  { date: '2026-10-01', purchase_date: '2026-09-04', amount: 78.5, type: 'despesa', description: 'IFD*IFOOD.COM BR', payment_method: 'credito', external_id: 'ofx:F1' },
  { date: '2026-10-01', purchase_date: '2026-09-05', amount: 24.9, type: 'despesa', description: 'UBER *TRIP SAO PAULO', payment_method: 'credito', external_id: 'ofx:F2' },
  { date: '2026-10-01', purchase_date: '2026-09-08', amount: 52.9, type: 'despesa', description: 'SUPERMERCADO BH', payment_method: 'credito', external_id: 'ofx:F3' },
  { date: '2026-10-01', purchase_date: '2026-09-15', amount: 199.9, type: 'despesa', description: 'LOJA NOVA', payment_method: 'credito', external_id: 'ofx:F4' },
];

let r = await call('POST', '/transactions/import', { transactions: fatura, dry_run: true });
check('pré-visualização responde', r.status === 200, r.body);
const byIndex = Object.fromEntries(r.body.results.map((x) => [x.index, x]));

check('descrição diferente, data 1 dia depois -> concilia', byIndex[0].status === 'match' && byIndex[0].match.id === ifood.id, byIndex[0]);
check('conciliação exata é marcada como exact', byIndex[0].match.kind === 'exact', byIndex[0].match);
check('mostra o lançamento do usuário', byIndex[0].match.description === 'iFood' && byIndex[0].match.amount === 78.5, byIndex[0].match);
check('mesmo dia e mesmo valor -> concilia', byIndex[1].status === 'match' && byIndex[1].match.id === uber.id, byIndex[1]);
check('valor diferente dentro da tolerância -> concilia avisando', byIndex[2].status === 'match' && byIndex[2].match.kind === 'amount-differs' && byIndex[2].match.id === mercado.id, byIndex[2]);
check('compra que faltava lançar entra como nova', byIndex[3].status === 'ok', byIndex[3]);
check('resumo conta os conciliáveis', r.body.matches === 3 && r.body.toImport === 1, r.body);
check('lançamento longe da data não é tocado', r.body.results.every((x) => x.status !== 'match' || x.match.id !== almoco.id), r.body.results);

// Concilia: dois mantendo o valor, um corrigindo
r = await call('POST', '/transactions/reconcile', {
  items: [
    { transaction_id: ifood.id, external_id: 'ofx:F1' },
    { transaction_id: uber.id, external_id: 'ofx:F2' },
    { transaction_id: mercado.id, external_id: 'ofx:F3', amount: 52.9 },
  ],
});
check('concilia os três', r.status === 200 && r.body.reconciled === 3 && r.body.amountsFixed === 1, r.body);

let lista = (await call('GET', '/transactions?month=2026-10')).body;
check('nada foi duplicado', lista.length === 4, lista.map((t) => t.description));
check('valor corrigido no lançamento do usuário', lista.find((t) => t.id === mercado.id).amount === '52.90', lista.find((t) => t.id === mercado.id));
check('descrição do usuário é preservada', lista.find((t) => t.id === ifood.id).description === 'iFood', lista.find((t) => t.id === ifood.id));

// Importa a compra que faltava
r = await call('POST', '/transactions/import', { transactions: [fatura[3]] });
check('importa só o que faltava', r.body.imported === 1, r.body);

// Reimportar a fatura inteira agora não sugere nada nem duplica
r = await call('POST', '/transactions/import', { transactions: fatura, dry_run: true });
check('depois de conciliar, tudo vira duplicado', r.body.duplicates === 4 && r.body.matches === 0, r.body);
r = await call('POST', '/transactions/import', { transactions: fatura });
check('importação repetida não grava nada', r.body.imported === 0, r.body);
lista = (await call('GET', '/transactions?month=2026-10')).body;
check('total continua 5', lista.length === 5, lista.length);

// Proteções do endpoint de conciliação
r = await call('POST', '/transactions/reconcile', { items: [{ transaction_id: ifood.id, external_id: 'ofx:NOVO' }] });
check('não reconcilia duas vezes', r.body.reconciled === 0 && r.body.skipped[0].reason === 'Já conciliado antes', r.body);
r = await call('POST', '/transactions/reconcile', { items: [{ transaction_id: almoco.id, external_id: 'ofx:F1' }] });
check('identificador já usado é recusado', r.body.reconciled === 0 && r.body.skipped[0].reason.includes('já está conciliado'), r.body);
r = await call('POST', '/transactions/reconcile', { items: [{ transaction_id: 999999, external_id: 'ofx:X' }] });
check('lançamento inexistente é recusado', r.body.skipped[0].reason === 'Lançamento não encontrado', r.body);

const outro = await call('POST', '/auth/register', { name: 'Outro', email: `o${Date.now()}@t.com`, password: 'senha-teste-123' });
const t1 = token; token = outro.body.token;
r = await call('POST', '/transactions/reconcile', { items: [{ transaction_id: almoco.id, external_id: 'ofx:Z' }] });
check('não concilia lançamento de outro usuário', r.body.reconciled === 0, r.body);
token = t1;

r = await call('POST', '/transactions/reconcile', { items: [] });
check('lista vazia -> 400', r.status === 400, r);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
