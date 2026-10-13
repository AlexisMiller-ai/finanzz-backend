// Executor dos testes de ponta a ponta.
//
// Sobe um Postgres de verdade em memória (PGlite), aplica db/schema.sql e
// todas as migrations, liga a API apontando para ele e roda cada arquivo
// tests/*.test.mjs contra a API, um depois do outro. Nada depende do banco de
// produção nem de serviços externos.
//
// Uso: npm test            (todas as suítes)
//      npm test -- contas  (só as que tiverem "contas" no nome)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTA_DB = Number(process.env.TEST_DB_PORT ?? 54329);
const PORTA_API = Number(process.env.TEST_API_PORT ?? 3399);
const API_URL = `http://127.0.0.1:${PORTA_API}`;
const filtro = process.argv[2];
// O app calcula "hoje" no fuso de Brasília; banco, API e testes usam o mesmo,
// senão entre 21h e meia-noite o servidor de CI (em UTC) já estaria no dia seguinte.
const FUSO = "America/Sao_Paulo";

async function subirBanco() {
  const db = await PGlite.create();
  await db.exec(`SET TIME ZONE '${FUSO}'; ALTER DATABASE postgres SET timezone TO '${FUSO}';`);
  await db.exec(fs.readFileSync(path.join(RAIZ, "db/schema.sql"), "utf8"));
  const migrations = fs.readdirSync(path.join(RAIZ, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const arquivo of migrations) {
    await db.exec(fs.readFileSync(path.join(RAIZ, "db/migrations", arquivo), "utf8"));
  }
  const servidor = new PGLiteSocketServer({ db, port: PORTA_DB, host: "127.0.0.1", maxConnections: 20 });
  await servidor.start();
  console.log(`banco de teste pronto (${migrations.length} migrations aplicadas)`);
  return servidor;
}

function subirApi() {
  const api = spawn(process.execPath, ["-r", "ts-node/register/transpile-only", "src/index.ts"], {
    cwd: RAIZ,
    env: {
      ...process.env,
      PORT: String(PORTA_API),
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PORTA_DB}/postgres`,
      DATABASE_SSL: "false",
      JWT_SECRET: "chave-usada-so-nos-testes-automatizados",
      NODE_ENV: "test",
      TZ: FUSO,
      DOTENV_CONFIG_QUIET: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  api.stdout.on("data", (d) => (log += d));
  api.stderr.on("data", (d) => (log += d));
  return { api, log: () => log };
}

async function esperarApi(limiteMs = 60_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    try {
      const resposta = await fetch(`${API_URL}/health`);
      if (resposta.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("A API não respondeu a tempo");
}

function rodarSuite(arquivo) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [arquivo], {
      cwd: RAIZ,
      env: { ...process.env, API_URL, TZ: FUSO },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let saida = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (saida += d));
    filho.on("close", (codigo) => resolve({ codigo, saida }));
  });
}

const suites = fs
  .readdirSync(path.join(RAIZ, "tests"))
  .filter((f) => f.endsWith(".test.mjs") && (!filtro || f.includes(filtro)))
  .sort();

const banco = await subirBanco();
const { api, log } = subirApi();
let falhas = 0;

try {
  await esperarApi();
  for (const suite of suites) {
    const { codigo, saida } = await rodarSuite(path.join("tests", suite));
    const passou = saida.split("\n").filter((l) => l.startsWith("PASS")).length;
    if (codigo === 0) {
      console.log(`✓ ${suite} (${passou} verificações)`);
    } else {
      falhas++;
      console.log(`✗ ${suite}`);
      console.log(
        saida
          .split("\n")
          .filter((l) => !l.startsWith("PASS"))
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
  }
} catch (erro) {
  falhas++;
  console.error(erro.message);
  console.error(log());
} finally {
  api.kill();
  await banco.stop();
}

console.log(falhas ? `\n${falhas} suíte(s) com falha` : `\n${suites.length} suítes passaram`);
process.exit(falhas ? 1 : 0);
