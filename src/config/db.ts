import { Pool, PoolClient, types } from "pg";
import dotenv from "dotenv";

dotenv.config();

// Colunas DATE voltam como string "YYYY-MM-DD". Sem isso o driver cria um Date
// no fuso do servidor e a data pode "voltar um dia" dependendo do ambiente.
types.setTypeParser(1082, (value) => value);

const connectionString = process.env.DATABASE_URL;
const isLocal = !!connectionString && /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
const useSsl = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL !== "false"
  : !isLocal;

export const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
