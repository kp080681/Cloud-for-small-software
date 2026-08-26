import "dotenv/config";
import crypto from "node:crypto";
import { tasks } from "@trigger.dev/sdk";
import { ensureSchema, getRecord, storeSecret } from "./secret-store.mjs";

for (const name of ["DATABASE_URL", "AWS_REGION", "AWS_KMS_KEY_ID", "TRIGGER_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

await ensureSchema();
const secretId = `secret-${crypto.randomUUID()}`;
const workspaceId = "workspace-spike-e";
const appId = "app-spike-e";
const plaintext = `ssc-${crypto.randomBytes(32).toString("hex")}`;
const stored = await storeSecret({ secretId, workspaceId, appId, secretName: "SPIKE_E_TEST_SECRET", plaintext });
const record = await getRecord(secretId);
if (!record) throw new Error("Encrypted record not persisted");
if (record.ciphertext.includes(plaintext)) throw new Error("Plaintext leaked into ciphertext storage");

const handle = await tasks.trigger("ssc-spike-e-verify-secret", { secretId, workspaceId, appId });

console.log(JSON.stringify({
  result: "SPIKE_E_QUEUED",
  secretId,
  triggerRunId: handle.id,
  persistedPlaintext: false,
  encryptedDataKeyStored: Boolean(record.encrypted_data_key),
  ciphertextStored: Boolean(record.ciphertext),
  digest: stored.digest,
  plaintextPrinted: false,
}, null, 2));
