import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || './issues.db';
const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // better concurrent read/write behavior

function runMigrations() {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (version <= currentVersion) continue;

    console.log(`Applying migration ${file}...`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
    db.pragma(`user_version = ${version}`);
  }
}

runMigrations();

export default db;