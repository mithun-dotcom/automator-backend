const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Keep DATE columns as 'YYYY-MM-DD' strings and NUMERIC as numbers, so no
// timezone shifting happens between Postgres and the browser.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// DATABASE_SCHEMA keeps every portal table in its own Postgres schema, so the
// portal can share a database with another app without touching its tables.
const SCHEMA = process.env.DATABASE_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
  console.error('DATABASE_SCHEMA must be a lowercase identifier');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  options: `-c search_path=${SCHEMA}`,
});

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await pool.query(sql);
}

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query, migrate };
