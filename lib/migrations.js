'use strict';

const crypto = require('node:crypto');

const LOCK_NAMESPACE = 741203;
const LOCK_ID = 1;

function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations)) throw new TypeError('Migrations must be an array');
  const ids = new Set();
  for (const migration of migrations) {
    if (!migration || typeof migration.id !== 'string' ||
        !/^[0-9]{3,6}_[a-z0-9_]+$/.test(migration.id) ||
        typeof migration.sql !== 'string' || !migration.sql.trim()) {
      throw new TypeError('Each migration requires a stable id and non-empty SQL');
    }
    if (ids.has(migration.id)) throw new Error('Duplicate migration id: ' + migration.id);
    ids.add(migration.id);
  }
}

async function runMigrations(pool, migrations = []) {
  validateMigrations(migrations);
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, LOCK_ID]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS mesh_schema_migrations (
        migration_id VARCHAR(120) PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await client.query(
      'SELECT migration_id, checksum FROM mesh_schema_migrations'
    );
    const appliedById = new Map(applied.rows.map(row => [row.migration_id, row.checksum.trim()]));

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      const previous = appliedById.get(migration.id);
      if (previous) {
        if (previous !== checksum) {
          throw new Error('Applied migration checksum mismatch: ' + migration.id);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO mesh_schema_migrations(migration_id, checksum) VALUES ($1, $2)',
          [migration.id, checksum]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_ID]);
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
  }
}

module.exports = { migrationChecksum, validateMigrations, runMigrations };
