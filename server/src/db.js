// PostgreSQL pool + transaction helper
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'hms',
  user: process.env.DB_USER || 'hms_user',
  password: process.env.DB_PASS || '',
  max: Number(process.env.DB_POOL_MAX || 5),
  options: '-c search_path=hms',
});

export async function q(text, params) {
  return pool.query(text, params);
}

// Run fn inside a transaction; rolls back on throw.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
