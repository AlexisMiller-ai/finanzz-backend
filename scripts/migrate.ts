import fs from "fs";
import path from "path";
import { pool } from "../src/config/db";

// Executa, em ordem, todos os arquivos .sql de db/migrations.
// As migrations são idempotentes, então rodar de novo não causa problema.
async function main() {
  const dir = path.join(__dirname, "..", "db", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`Aplicando ${file}...`);
    await pool.query(sql);
  }

  console.log("Migrations aplicadas.");
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
