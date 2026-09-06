import crypto from "node:crypto";

export const RECOVERY_PROBE_TABLE = "ssc_recovery_probe";

export function safeSha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function normalizeConnectionIdentity(connectionUri) {
  const url = new URL(connectionUri);
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
    sslmode: url.searchParams.get("sslmode") ?? null,
  };
}

export function summarizeProbeRows(rows) {
  const normalized = rows.map((row) => ({
    id: Number(row.id),
    value: String(row.value),
  }));
  return {
    rowCount: normalized.length,
    digest: safeSha256(JSON.stringify(normalized)),
  };
}

export async function readProbeSummary(db) {
  const result = await db.query(
    `SELECT id, value
       FROM ssc_recovery_probe
      ORDER BY id ASC`,
  );
  return summarizeProbeRows(result.rows);
}

export async function initializeProbeData(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ssc_recovery_probe (id integer PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`TRUNCATE ssc_recovery_probe`);
  await db.query(`INSERT INTO ssc_recovery_probe (id, value) VALUES (1,'alpha'),(2,'bravo'),(3,'charlie')`);
  return readProbeSummary(db);
}

export async function mutateProbeData(db) {
  await db.query(`DELETE FROM ssc_recovery_probe`);
  return readProbeSummary(db);
}

export function assertProbeMutationChanged({ original, mutated, mutationDbIdentity, verificationDbIdentity }) {
  if (JSON.stringify(mutationDbIdentity) !== JSON.stringify(verificationDbIdentity)) {
    throw new Error("Mutation and post-mutation verification used different database identities");
  }
  const rowCountChanged = mutated.rowCount !== original.rowCount;
  const digestChanged = mutated.digest !== original.digest;
  const mutationChangedState = rowCountChanged || digestChanged;
  if (!mutationChangedState) throw new Error("Destructive test mutation did not change probe data");
  if (mutated.rowCount !== 0) throw new Error("Destructive test mutation did not delete all probe rows");
  return {
    mutationChangedState,
    rowCountChanged,
    digestChanged,
    postMutationRowCount: mutated.rowCount,
  };
}
