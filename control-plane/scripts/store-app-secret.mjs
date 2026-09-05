import pg from "pg";
import { requireWorkspaceId, resolveAppTarget } from "../src/operator-targeting.mjs";
import { encryptAppSecret } from "../src/secret-store.mjs";

const required = [
  "DATABASE_URL",
  "CONTROL_PLANE_WORKSPACE_ID",
  "CONTROL_PLANE_APP_ID",
  "AWS_REGION",
  "AWS_KMS_KEY_ID",
];

for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const workspaceId = requireWorkspaceId();

try {
  const app = await resolveAppTarget(db, { workspaceId, appId: process.env.CONTROL_PLANE_APP_ID });
  for (const name of ["CONTROL_PLANE_SECRET_NAME", "CONTROL_PLANE_SECRET_VALUE"]) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
  const stored = await encryptAppSecret(db, {
    workspaceId: app.workspace_id,
    appId: app.id,
    name: process.env.CONTROL_PLANE_SECRET_NAME,
    plaintext: process.env.CONTROL_PLANE_SECRET_VALUE,
  });

  console.log(JSON.stringify({
    result: "NODE_04_6_SECRET_STORED",
    appId: app.id,
    appName: app.name,
    secretId: stored.id,
    secretName: stored.name,
    kmsKeyIdPresent: Boolean(stored.kms_key_id),
    plaintextPrinted: false,
    plaintextPersisted: false,
    ciphertextPersisted: true,
    encryptedDataKeyPersisted: true,
  }, null, 2));
} finally {
  await db.end();
}
