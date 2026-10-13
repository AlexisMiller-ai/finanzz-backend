// Limite de tentativas, senha mínima, sessão encerrada na troca de senha e
// cabeçalhos de segurança. Cada cenário usa um IP próprio (x-forwarded-for)
// para não interferir nas outras suítes.
const B = process.env.API_URL ?? 'http://localhost:3334';
let fails = 0;
const call = async (method, path, body, { token, ip } = {}) => {
  const r = await fetch(B + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let json; try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json, headers: r.headers };
};
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra)));
  if (!cond) fails++;
};
const unico = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const SENHA = 'senha-forte-123';

// ---- senha mínima ----
let r = await call('POST', '/auth/register', { name: 'Curta', email: `curta${unico()}@t.com`, password: '1234567' }, { ip: '10.0.0.1' });
check('senha com menos de 8 caracteres é recusada', r.status === 400, r.body);

// ---- bloqueio por e-mail depois de 8 senhas erradas ----
const email = `alvo${unico()}@t.com`;
await call('POST', '/auth/register', { name: 'Alvo', email, password: SENHA }, { ip: '10.0.1.1' });
let ultimos = [];
for (let i = 0; i < 8; i++) {
  ultimos.push((await call('POST', '/auth/login', { email, password: `errada-${i}` }, { ip: `10.0.2.${i}` })).status);
}
check('as 8 primeiras senhas erradas recebem 401', ultimos.every((s) => s === 401), ultimos);
r = await call('POST', '/auth/login', { email, password: SENHA }, { ip: '10.0.2.99' });
check('depois disso, nem a senha certa entra (429)', r.status === 429, r.body);
check('a resposta diz quando tentar de novo', Number(r.headers.get('retry-after')) > 0 && /minuto/.test(r.body.message), {
  retry: r.headers.get('retry-after'), body: r.body,
});
r = await call('POST', '/auth/login', { email: email.toUpperCase(), password: SENHA }, { ip: '10.0.2.98' });
check('o bloqueio não é contornado mudando maiúsculas', r.status === 429, r.body);

// ---- login certo zera a contagem do e-mail ----
const email2 = `zera${unico()}@t.com`;
await call('POST', '/auth/register', { name: 'Zera', email: email2, password: SENHA }, { ip: '10.0.3.1' });
for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { email: email2, password: 'errada' }, { ip: '10.0.3.2' });
r = await call('POST', '/auth/login', { email: email2, password: SENHA }, { ip: '10.0.3.2' });
check('login certo antes do limite entra', r.status === 200, r.body);
const depois = [];
for (let i = 0; i < 7; i++) depois.push((await call('POST', '/auth/login', { email: email2, password: 'errada' }, { ip: '10.0.3.3' })).status);
check('e a contagem recomeça do zero', depois.every((s) => s === 401), depois);

// ---- bloqueio por IP, trocando de e-mail a cada tentativa ----
const ip = '10.0.4.1';
const tentativas = [];
for (let i = 0; i < 30; i++) {
  tentativas.push((await call('POST', '/auth/login', { email: `x${i}${unico()}@t.com`, password: 'qualquer' }, { ip })).status);
}
check('30 tentativas de um mesmo IP com e-mails diferentes passam', tentativas.every((s) => s === 401), tentativas);
r = await call('POST', '/auth/login', { email: email2, password: SENHA }, { ip });
check('a 31ª do mesmo IP é bloqueada', r.status === 429, r.body);
r = await call('POST', '/auth/login', { email: email2, password: SENHA }, { ip: '10.0.4.2' });
check('outro IP continua entrando', r.status === 200, r.body);

// ---- limite de cadastro por IP (50 no ambiente de teste) ----
const ipCadastro = '10.0.5.1';
const cadastros = [];
for (let i = 0; i < 50; i++) {
  cadastros.push((await call('POST', '/auth/register', { name: 'Massa', email: `massa${i}${unico()}@t.com`, password: SENHA }, { ip: ipCadastro })).status);
}
check('cadastros até o limite passam', cadastros.every((s) => s === 201), cadastros.filter((s) => s !== 201));
r = await call('POST', '/auth/register', { name: 'Massa', email: `massa-extra${unico()}@t.com`, password: SENHA }, { ip: ipCadastro });
check('o cadastro seguinte do mesmo IP é bloqueado', r.status === 429, r.body);

// ---- trocar a senha encerra as outras sessões ----
const email3 = `sessao${unico()}@t.com`;
const celular = (await call('POST', '/auth/register', { name: 'Sessão', email: email3, password: SENHA }, { ip: '10.0.6.1' })).body.token;
// o iat do JWT é em segundos: espera virar o segundo para os tokens serem distinguíveis
await new Promise((res) => setTimeout(res, 1100));
const computador = (await call('POST', '/auth/login', { email: email3, password: SENHA }, { ip: '10.0.6.2' })).body.token;
check('duas sessões abertas funcionam', (await call('GET', '/accounts', null, { token: celular })).status === 200 &&
  (await call('GET', '/accounts', null, { token: computador })).status === 200, null);
await new Promise((res) => setTimeout(res, 1100));
r = await call('PUT', '/auth/password', { current_password: SENHA, new_password: 'outra-senha-789' }, { token: computador });
check('troca de senha devolve token novo', r.status === 200 && typeof r.body.token === 'string', r.body);
const novo = r.body.token;
r = await call('GET', '/accounts', null, { token: celular });
check('a outra sessão é desconectada', r.status === 401, r.body);
check('o token antigo de quem trocou também deixa de valer', (await call('GET', '/accounts', null, { token: computador })).status === 401, null);
check('o token novo funciona', (await call('GET', '/accounts', null, { token: novo })).status === 200, null);
check('a senha antiga não entra mais', (await call('POST', '/auth/login', { email: email3, password: SENHA }, { ip: '10.0.6.3' })).status === 401, null);
check('a senha nova entra', (await call('POST', '/auth/login', { email: email3, password: 'outra-senha-789' }, { ip: '10.0.6.3' })).status === 200, null);
r = await call('PUT', '/auth/password', { current_password: 'outra-senha-789', new_password: 'curta' }, { token: novo });
check('a senha nova também precisa de 8 caracteres', r.status === 400, r.body);

// ---- tokens inválidos ----
check('sem token -> 401', (await call('GET', '/accounts')).status === 401, null);
check('token malformado -> 401', (await call('GET', '/accounts', null, { token: 'abc.def.ghi' })).status === 401, null);

// ---- cabeçalhos ----
r = await call('GET', '/health');
check('não anuncia o servidor (X-Powered-By)', r.headers.get('x-powered-by') === null, r.headers.get('x-powered-by'));
check('nosniff', r.headers.get('x-content-type-options') === 'nosniff', null);
check('não abre em frame', r.headers.get('x-frame-options') === 'DENY', null);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
