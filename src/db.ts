import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_TYPE = process.env.DB_TYPE || 'sqlite';
const DB_PATH = process.env.DB_PATH || './issues.db';
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

interface RunResult {
  lastInsertRowid?: number | bigint;
  changes: number;
}

interface DbAdapter {
  exec(sql: string): Promise<void>;
  getVersion(): Promise<number>;
  setVersion(v: number): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  raw: unknown;
}

// Converts SQLite-style `?` positional placeholders to Postgres-style `$1, $2, ...`.
// Only safe because none of this app's SQL contains literal `?` characters
// (e.g. inside quoted strings) — if that ever changes, this needs a real parser.
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function sqliteAdapter(): DbAdapter {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');

  return {
    async exec(sql) {
      sqlite.exec(sql);
    },
    async getVersion() {
      return sqlite.pragma('user_version', { simple: true }) as number;
    },
    async setVersion(v) {
      sqlite.pragma(`user_version = ${v}`);
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      const info = sqlite.prepare(sql).run(...params);
      return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
    },
    raw: sqlite,
  };
}

function postgresAdapter(): DbAdapter {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required when DB_TYPE=postgres');
  }

  // Lazy require — only loaded when DB_TYPE=postgres, so SQLite-only
  // installs don't need `pg` present at runtime.
  const { Pool } = require('pg') as typeof import('pg');
  const pool = new Pool({ connectionString: DATABASE_URL });

  return {
    async exec(sql) {
      await pool.query(sql);
    },
    async getVersion() {
      await pool.query('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const res = await pool.query('SELECT version FROM schema_version LIMIT 1');
      return res.rows[0]?.version ?? 0;
    },
    async setVersion(v) {
      await pool.query('DELETE FROM schema_version');
      await pool.query('INSERT INTO schema_version (version) VALUES ($1)', [v]);
    },
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(toPgPlaceholders(sql), params);
      return res.rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(toPgPlaceholders(sql), params);
      return res.rows[0] as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      // Postgres has no built-in lastInsertRowid; callers that need the new
      // id should append `RETURNING id` to their INSERT and use `.get()` or
      // `.query()` instead of `.run()`.
      const res = await pool.query(toPgPlaceholders(sql), params);
      return { changes: res.rowCount ?? 0 };
    },
    raw: pool,
  };
}

const db: DbAdapter = DB_TYPE === 'postgres' ? postgresAdapter() : sqliteAdapter();

async function runMigrations() {
  const currentVersion = await db.getVersion();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (version <= currentVersion) continue;
    console.log(`Applying migration ${file}...`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.exec(sql);
    await db.setVersion(version);
  }
}

const dbReady: Promise<void> = runMigrations();

export default db;
export { dbReady };
export type { DbAdapter };