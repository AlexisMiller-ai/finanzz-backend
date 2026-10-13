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

const reg = await call('POST', '/auth/register', { name: 'Import', email: `imp${Date.now()}@t.com`, password: '123456' });
token = reg.body.token;
const cats = (await call('GET', '/categories')).body;
const food = cats.find((c) => c.name === 'Alimentação').id;
const salary = cats.find((c) => c.name === 'Salário').id;

const linhas = [
  { date: '2026-09-02', amount: 120.5, type: 'despesa', description: 'MERCADO BOM PRECO', category_id: food, external_id: 'ofx:A1' },
  { date: '2026-09-03', amount: 4500, type: 'receita', description: 'SALARIO', category_id: salary, external_id: 'ofx:A2' },
  { date: '2026-09-04', amount: 32.9, type: 'despesa', description: 'PADARIA', external_id: 'ofx:A3' },
];

// 1) pré-visualização não grava nada
let r = await call('POST', '/transactions/import', { transactions: linhas, dry_run: true });
check('dry run analisa', r.status === 200 && r.body.dryRun === true && r.body.toImport === 3, r.body);
let lista = (await call('GET', '/transactions?month=2026-09')).body;
check('dry run não grava', lista.length === 0, lista.length);

// 2) importação real
r = await call('POST', '/transactions/import', { transactions: linhas });
check('importa 3', r.status === 201 && r.body.imported === 3 && r.body.duplicates === 0, r.body);
lista = (await call('GET', '/transactions?month=2026-09')).body;
check('gravou com categoria e tipo', lista.length === 3 && lista.find((t) => t.description === 'SALARIO').type === 'receita', lista.map((t) => t.description));

// 3) reimportar o mesmo arquivo não duplica
r = await call('POST', '/transactions/import', { transactions: linhas });
check('reimportação é bloqueada', r.body.imported === 0 && r.body.duplicates === 3, r.body);
check('aponta o lançamento existente', r.body.results.every((x) => x.status === 'duplicate' && x.duplicateOf), r.body.results);
lista = (await call('GET', '/transactions?month=2026-09')).body;
check('total continua 3', lista.length === 3, lista.length);

// 4) linha igual sem identificador próprio (CSV) também é detectada
r = await call('POST', '/transactions/import', {
  transactions: [{ date: '2026-09-02', amount: 120.5, type: 'despesa', description: 'MERCADO BOM PRECO' }],
});
check('duplicado sem external_id', r.body.imported === 0 && r.body.duplicates === 1, r.body);

// 5) duas compras iguais no mesmo dia: a segunda deve entrar
r = await call('POST', '/transactions/import', {
  transactions: [
    { date: '2026-09-04', amount: 32.9, type: 'despesa', description: 'PADARIA' },
    { date: '2026-09-04', amount: 32.9, type: 'despesa', description: 'PADARIA' },
  ],
});
check('duas iguais: 1 duplicada, 1 importada', r.body.imported === 1 && r.body.duplicates === 1, r.body);

// 6) validação linha a linha, sem derrubar o lote
r = await call('POST', '/transactions/import', {
  transactions: [
    { date: '2026-09-10', amount: 0, type: 'despesa', description: 'Zerado' },
    { date: '2026-13-40', amount: 10, type: 'despesa', description: 'Data ruim' },
    { date: '2026-09-10', amount: 10, type: 'investimento', description: 'Tipo ruim' },
    { date: '2026-09-10', amount: 10, type: 'despesa', category_id: salary, description: 'Categoria de outro tipo' },
    { date: '2026-09-10', amount: 10, type: 'despesa', category_id: 999999, description: 'Categoria inexistente' },
    { date: '2026-09-10', amount: 77.7, type: 'despesa', description: 'Linha boa' },
  ],
});
check('erros isolados e linha boa importada', r.body.imported === 1 && r.body.errors === 5, r.body);
check('mensagens por linha', r.body.results.filter((x) => x.status === 'error').map((x) => x.message).join('|') ===
  'Valor inválido|Data inválida|Tipo inválido|Categoria de outro tipo|Categoria não encontrada', r.body.results);

// 7) fatura de cartão guarda a data da compra
r = await call('POST', '/transactions/import', {
  transactions: [{ date: '2026-10-01', amount: 200, type: 'despesa', description: 'FATURA ITEM', payment_method: 'credito', purchase_date: '2026-09-20', external_id: 'csv:h1' }],
});
check('importa item de fatura', r.body.imported === 1, r.body);
const outubro = (await call('GET', '/transactions?month=2026-10')).body;
check('data da compra preservada', outubro[0]?.purchase_date === '2026-09-20' && outubro[0]?.payment_method === 'credito', outubro[0]);

// 8) receita nunca vira crédito
r = await call('POST', '/transactions/import', {
  transactions: [{ date: '2026-10-05', amount: 50, type: 'receita', description: 'PIX RECEBIDO', payment_method: 'credito', external_id: 'csv:h2' }],
});
const out2 = (await call('GET', '/transactions?month=2026-10')).body.find((t) => t.description === 'PIX RECEBIDO');
check('receita não fica no crédito', out2?.payment_method === 'dinheiro', out2);

// 9) limites
r = await call('POST', '/transactions/import', { transactions: [] });
check('lista vazia -> 400', r.status === 400, r);
r = await call('POST', '/transactions/import', { transactions: Array.from({ length: 501 }, () => ({ date: '2026-09-01', amount: 1, type: 'despesa' })) });
check('acima de 500 -> 400', r.status === 400, r);

// 10) isolamento entre usuários
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `out${Date.now()}@t.com`, password: '123456' });
const t1 = token; token = outro.body.token;
r = await call('POST', '/transactions/import', { transactions: [{ date: '2026-09-02', amount: 120.5, type: 'despesa', description: 'MERCADO BOM PRECO', external_id: 'ofx:A1' }] });
check('mesmo external_id de outro usuário é permitido', r.body.imported === 1, r.body);
r = await call('POST', '/transactions/import', { transactions: [{ date: '2026-09-02', amount: 10, type: 'despesa', category_id: food }] });
check('categoria de outro usuário recusada', r.body.errors === 1, r.body);
token = t1;

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
