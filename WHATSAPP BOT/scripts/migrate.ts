import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/db/pool.js';

const dir = path.join(process.cwd(), 'migrations');

await pool.query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     name text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
);

const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
  if (applied.rowCount) {
    console.log(`skip  ${file}`);
    continue;
  }
  const sql = await readFile(path.join(dir, file), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`apply ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAIL  ${file}`);
    throw err;
  } finally {
    client.release();
  }
}

await pool.end();
