import crypto from "node:crypto";
import { KMSClient, DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { neon } from "@neondatabase/serverless";

const sql = () => neon(process.env.DATABASE_URL);
const kms = () => new KMSClient({ region: process.env.AWS_REGION });
const context = (scope) => ({ namespace: "ssc-spike-e", workspace: scope.workspaceId, app: scope.appId, secret: scope.secretId });

export async function ensureSchema() {
  await sql()`create table if not exists spike_e_secrets (
    secret_id text primary key, workspace_id text not null, app_id text not null,
    secret_name text not null, encrypted_data_key text not null, iv text not null,
    auth_tag text not null, ciphertext text not null, digest text not null,
    created_at timestamptz not null default now()
  )`;
}

export async function storeSecret({ secretId, workspaceId, appId, secretName, plaintext }) {
  const scope = { secretId, workspaceId, appId };
  const generated = await kms().send(new GenerateDataKeyCommand({
    KeyId: process.env.AWS_KMS_KEY_ID, KeySpec: "AES_256", EncryptionContext: context(scope),
  }));
  if (!generated.Plaintext || !generated.CiphertextBlob) throw new Error("KMS data key unavailable");
  const key = Buffer.from(generated.Plaintext);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(context(scope))));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const digest = crypto.createHash("sha256").update(plaintext).digest("hex");
    await sql()`insert into spike_e_secrets values (
      ${secretId}, ${workspaceId}, ${appId}, ${secretName},
      ${Buffer.from(generated.CiphertextBlob).toString("base64")}, ${iv.toString("base64")},
      ${tag.toString("base64")}, ${encrypted.toString("base64")}, ${digest}, now()
    )`;
    return { secretId, digest };
  } finally { key.fill(0); }
}

export async function getRecord(secretId) {
  const rows = await sql()`select * from spike_e_secrets where secret_id=${secretId}`;
  return rows[0] ?? null;
}

export async function decryptSecret(secretId, expected) {
  const row = await getRecord(secretId);
  if (!row) throw new Error("Secret not found");
  if (row.workspace_id !== expected.workspaceId || row.app_id !== expected.appId) throw new Error("Secret scope mismatch");
  const scope = { secretId, workspaceId: row.workspace_id, appId: row.app_id };
  const result = await kms().send(new DecryptCommand({
    CiphertextBlob: Buffer.from(row.encrypted_data_key, "base64"), EncryptionContext: context(scope),
  }));
  if (!result.Plaintext) throw new Error("KMS decrypt failed");
  const key = Buffer.from(result.Plaintext);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(JSON.stringify(context(scope))));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } finally { key.fill(0); }
}
