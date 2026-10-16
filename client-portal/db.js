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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query, migrate };
