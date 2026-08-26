import crypto from "node:crypto";
import { KMSClient, DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";

function kms() {
  if (!process.env.AWS_REGION) throw new Error("Missing AWS_REGION");
  return new KMSClient({ region: process.env.AWS_REGION });
}

function encryptionContext({ workspaceId, appId, name }) {
  return {
    namespace: "small-software-cloud",
    workspace: workspaceId,
    app: appId,
    secret: name,
  };
}

export async function encryptAppSecret(db, { workspaceId, appId, name, plaintext }) {
  if (!process.env.AWS_KMS_KEY_ID) throw new Error("Missing AWS_KMS_KEY_ID");
  if (!plaintext) throw new Error("Secret plaintext must not be empty");

  const scope = { workspaceId, appId, name };
  const context = encryptionContext(scope);
  const generated = await kms().send(new GenerateDataKeyCommand({
    KeyId: process.env.AWS_KMS_KEY_ID,
    KeySpec: "AES_256",
    EncryptionContext: context,
  }));

  if (!generated.Plaintext || !generated.CiphertextBlob) throw new Error("KMS data key unavailable");
  const dataKey = Buffer.from(generated.Plaintext);

  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(context)));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const result = await db.query(
      `INSERT INTO encrypted_secrets
         (workspace_id, app_id, name, ciphertext, encrypted_data_key, iv, auth_tag, kms_key_id, encryption_context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (app_id, name) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         encrypted_data_key = EXCLUDED.encrypted_data_key,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         kms_key_id = EXCLUDED.kms_key_id,
         encryption_context = EXCLUDED.encryption_context,
         updated_at = now()
       RETURNING id, name, kms_key_id, created_at, updated_at`,
      [workspaceId, appId, name, ciphertext, Buffer.from(generated.CiphertextBlob), iv, authTag,
       process.env.AWS_KMS_KEY_ID, JSON.stringify(context)],
    );
    return result.rows[0];
  } finally {
    dataKey.fill(0);
  }
}

export async function decryptAppSecret(db, { appId, name }) {
  const result = await db.query(
    `SELECT id, workspace_id, app_id, name, ciphertext, encrypted_data_key, iv, auth_tag, encryption_context
       FROM encrypted_secrets WHERE app_id=$1 AND name=$2 LIMIT 1`,
    [appId, name],
  );
  if (result.rowCount === 0) throw new Error(`Secret not found: ${name}`);
  const row = result.rows[0];
  const context = row.encryption_context;

  if (context.namespace !== "small-software-cloud" || context.workspace !== row.workspace_id ||
      context.app !== row.app_id || context.secret !== row.name) {
    throw new Error("Secret encryption context mismatch");
  }

  const decrypted = await kms().send(new DecryptCommand({
    CiphertextBlob: row.encrypted_data_key,
    EncryptionContext: context,
  }));
  if (!decrypted.Plaintext) throw new Error("KMS decrypt failed");
  const dataKey = Buffer.from(decrypted.Plaintext);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, row.iv);
    decipher.setAAD(Buffer.from(JSON.stringify(context)));
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}
