import crypto from "node:crypto";
import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { decryptAppSecret } from "../src/secret-store.mjs";

const { Client } = pg;

export const verifySecret = task({
  id: "ssc-control-plane-verify-secret",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 10000,
    factor: 2,
    randomize: false,
  },
  run: async (payload: { appId: string; secretName: string; expectedDigest: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    try {
      const plaintext = await decryptAppSecret(db, {
        appId: payload.appId,
        name: payload.secretName,
      });

      const actualDigest = crypto.createHash("sha256").update(plaintext).digest("hex");
      const verified = crypto.timingSafeEqual(
        Buffer.from(actualDigest, "hex"),
        Buffer.from(payload.expectedDigest, "hex"),
      );

      return {
        result: verified ? "NODE_04_6_SECRET_VERIFIED" : "NODE_04_6_SECRET_MISMATCH",
        appId: payload.appId,
        secretName: payload.secretName,
        digestMatched: verified,
        plaintextPrinted: false,
        plaintextPersisted: false,
      };
    } finally {
      await db.end();
    }
  },
});
