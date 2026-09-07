import pg from "pg";
import { requireAppSlug, requireWorkspaceId, resolveAppTarget } from "../src/operator-targeting.mjs";
import { encryptAppSecret } from "../src/secret-store.mjs";

for (const name of ["DATABASE_URL", "AWS_REGION", "AWS_KMS_KEY_ID", "CONTROL_PLANE_WORKSPACE_ID", "CONTROL_PLANE_APP_SLUG"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const workspaceId = requireWorkspaceId();
const appSlug = requireAppSlug();

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const app = await resolveAppTarget(db, { workspaceId, slug: appSlug });
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
    appSlug: app.slug,
    secretId: stored.id,
    secretName: stored.name,
    plaintextPersisted: false,
    plaintextPrinted: false,
    ciphertextStored: true,
    encryptedDataKeyStored: true,
  }, null, 2));
} finally {
  await db.end();
}
