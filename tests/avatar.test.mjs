// Foto de perfil: só imagens de verdade, com tamanho limitado e só do próprio usuário.
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

// PNG 1x1 real
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// JPEG mínimo (cabeçalho FF D8 FF E0 ... )
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]).toString('base64');

const email = `av${Date.now()}@t.com`;
const reg = await call('POST', '/auth/register', { name: 'Foto', email, password: 'senha-teste-123' });
token = reg.body.token;

let r = await call('GET', '/auth/me');
check('sem foto no começo', r.body.avatar === null || r.body.avatar === undefined, r.body);

r = await call('PUT', '/auth/avatar', { image: PNG });
check('salva PNG', r.status === 200 && r.body.avatar === PNG, r.body);
check('/auth/me devolve a foto', (await call('GET', '/auth/me')).body.avatar === PNG);

r = await call('PUT', '/auth/avatar', { image: JPEG });
check('troca por JPEG', r.status === 200 && r.body.avatar === JPEG, r.body);

const t1 = token; token = undefined;
r = await call('POST', '/auth/login', { email, password: 'senha-teste-123' });
check('login devolve a foto', r.body.user?.avatar === JPEG, r.body.user);
token = t1;

r = await call('PUT', '/auth/me', { name: 'Foto Nova' });
check('editar nome mantém a foto', r.body.avatar === JPEG, r.body);

// --- recusas ---
const html = 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
check('recusa HTML', (await call('PUT', '/auth/avatar', { image: html })).status === 400);
const falso = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>aaaaaaaaaaaa</svg>').toString('base64');
check('recusa PNG falso (conteúdo não bate)', (await call('PUT', '/auth/avatar', { image: falso })).status === 400);
const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
check('recusa SVG', (await call('PUT', '/auth/avatar', { image: svg })).status === 400);
check('recusa URL externa', (await call('PUT', '/auth/avatar', { image: 'https://exemplo.com/foto.png' })).status === 400);
const media = 'data:image/png;base64,' + Buffer.alloc(70_000, 1).toString('base64');
check('recusa acima do limite da foto mesmo cabendo no corpo', (await call('PUT', '/auth/avatar', { image: media })).status === 400);
check('recusa vazio', (await call('PUT', '/auth/avatar', {})).status === 400);
const grande = 'data:image/png;base64,' + Buffer.alloc(80_000, 1).toString('base64');
r = await call('PUT', '/auth/avatar', { image: grande });
check('recusa imagem grande demais com 413 e mensagem', r.status === 413 && /grande demais/.test(r.body.message), r);
check('foto anterior continua depois das recusas', (await call('GET', '/auth/me')).body.avatar === JPEG);

// --- remover ---
r = await call('DELETE', '/auth/avatar');
check('remove a foto', r.status === 200 && r.body.avatar === null, r.body);
check('sem foto depois de remover', (await call('GET', '/auth/me')).body.avatar === null);

// --- isolamento ---
await call('PUT', '/auth/avatar', { image: PNG });
const outro = await call('POST', '/auth/register', { name: 'Outro', email: `o${Date.now()}@t.com`, password: 'senha-teste-123' });
token = outro.body.token;
check('outro usuário não vê a foto', !(await call('GET', '/auth/me')).body.avatar);
token = undefined;
check('exige login', (await call('PUT', '/auth/avatar', { image: PNG })).status === 401);

console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fails ? 1 : 0);
