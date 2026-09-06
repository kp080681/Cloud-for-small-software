import pg from "pg";
import {
  REQUIRED_CONTROL_PLANE_COLUMNS,
  REQUIRED_CONTROL_PLANE_TABLES,
  REQUIRED_CONTROL_PLANE_UNIQUE_CONSTRAINTS,
  publicTableIdentifier,
  restoreVerificationFailures,
} from "../src/recovery-safety.mjs";

const { Client } = pg;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function connect(name) {
  const db = new Client({ connectionString: requireEnv(name) });
  await db.connect();
  return db;
}

async function tableExists(db, table) {
  const result = await db.query(
    `SELECT true AS exists
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
        AND table_type = 'BASE TABLE'`,
    [table],
  );
  return result.rowCount === 1;
}

async function tableSummary(db, table) {
  if (!(await tableExists(db, table))) {
    return { table, exists: false, rowCount: null, minCreatedAt: null, maxCreatedAt: null };
  }
  const hasCreatedAt = await db.query(
    `SELECT true AS exists
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'created_at'`,
    [table],
  );
  if (hasCreatedAt.rowCount === 1) {
    const result = await db.query(`SELECT count(*)::int AS row_count, min(created_at) AS min_created_at, max(created_at) AS max_created_at FROM ${publicTableIdentifier(table)}`);
    return {
      table,
      exists: true,
      rowCount: result.rows[0].row_count,
      minCreatedAt: result.rows[0].min_created_at,
      maxCreatedAt: result.rows[0].max_created_at,
    };
  }
  const result = await db.query(`SELECT count(*)::int AS row_count FROM ${publicTableIdentifier(table)}`);
  return { table, exists: true, rowCount: result.rows[0].row_count, minCreatedAt: null, maxCreatedAt: null };
}

async function secretMetadataSummary(db) {
  if (!(await tableExists(db, "encrypted_secrets"))) {
    return { tableExists: false, rowCount: 0, completeMetadataCount: 0 };
  }
  const result = await db.query(
    `SELECT count(*)::int AS row_count,
            count(*) FILTER (
              WHERE ciphertext IS NOT NULL
                AND encrypted_data_key IS NOT NULL
                AND iv IS NOT NULL
                AND auth_tag IS NOT NULL
                AND kms_key_id IS NOT NULL
                AND encryption_context IS NOT NULL
            )::int AS complete_metadata_count
       FROM ${publicTableIdentifier("encrypted_secrets")}`,
  );
  return {
    tableExists: true,
    rowCount: result.rows[0].row_count,
    completeMetadataCount: result.rows[0].complete_metadata_count,
  };
}

async function missingRequiredColumns(db) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_CONTROL_PLANE_COLUMNS)) {
    for (const column of columns) {
      const result = await db.query(
        `SELECT true AS exists
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2`,
        [table, column],
      );
      if (result.rowCount !== 1) missing.push({ table, column });
    }
  }
  return missing;
}

async function missingRequiredUniqueConstraints(db) {
  const missing = [];
  for (const constraint of REQUIRED_CONTROL_PLANE_UNIQUE_CONSTRAINTS) {
    const result = await db.query(
      `SELECT true AS exists
         FROM pg_index i
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = $1
          AND i.indisunique
          AND (
            SELECT array_agg(a.attname::text ORDER BY u.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum
          ) = $2::text[]`,
      [constraint.table, constraint.columns],
    );
    if (result.rowCount !== 1) missing.push(constraint);
  }
  return missing;
}

const source = await connect("DATABASE_URL");
const restored = await connect("RESTORE_DATABASE_URL");

try {
  const sourceTables = [];
  const restoredTables = [];
  for (const table of REQUIRED_CONTROL_PLANE_TABLES) {
    sourceTables.push(await tableSummary(source, table));
    restoredTables.push(await tableSummary(restored, table));
  }

  const restoredByTable = new Map(restoredTables.map((summary) => [summary.table, summary]));
  const comparisons = sourceTables.map((summary) => {
    const restoredSummary = restoredByTable.get(summary.table);
    return {
      table: summary.table,
      sourceExists: summary.exists,
      restoredExists: restoredSummary?.exists ?? false,
      sourceRowCount: summary.rowCount,
      restoredRowCount: restoredSummary?.rowCount ?? null,
      rowCountMatches: summary.rowCount === restoredSummary?.rowCount,
    };
  });

  const schemaRestored = comparisons.every((item) => item.sourceExists === item.restoredExists);
  const rowCountParity = comparisons.every((item) => item.rowCountMatches);
  const secretRecovery = await secretMetadataSummary(restored);
  const missingColumns = await missingRequiredColumns(restored);
  const missingUniqueConstraints = await missingRequiredUniqueConstraints(restored);
  const failures = restoreVerificationFailures({
    comparisons,
    missingRequiredColumns: missingColumns,
    missingRequiredUniqueConstraints: missingUniqueConstraints,
    secretRecovery,
  });
  if (failures.length > 0) process.exitCode = 1;

  console.log(JSON.stringify({
    result: failures.length === 0 ? "CONTROL_PLANE_RESTORE_VERIFIED_READ_ONLY" : "CONTROL_PLANE_RESTORE_VERIFICATION_FAILED_READ_ONLY",
    schemaRestored,
    rowCountParity,
    tableCount: comparisons.filter((item) => item.restoredExists).length,
    comparisons,
    requiredSchemaVerification: {
      missingColumns,
      missingUniqueConstraints,
      mandatoryFailures: failures,
      passed: failures.length === 0,
    },
    secretRecovery: {
      rowCount: secretRecovery.rowCount,
      completeMetadataCount: secretRecovery.completeMetadataCount,
      metadataComplete: secretRecovery.rowCount === secretRecovery.completeMetadataCount,
      plaintextPrinted: false,
      decrypted: false,
    },
  }, null, 2));
} finally {
  await source.end();
  await restored.end();
}
