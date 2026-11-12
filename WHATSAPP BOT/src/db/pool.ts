import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logging/logger.js';

/** Money is stored in paise as integers. Never let pg hand back a float. */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, params as never[]);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(db, text, params);
  return rows[0];
}

/**
 * Run `fn` inside a transaction. Used for every write that must land with its
 * audit row and its state transition, or not at all.
 */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
