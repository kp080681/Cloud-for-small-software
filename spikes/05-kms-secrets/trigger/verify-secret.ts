import crypto from "node:crypto";
import { task } from "@trigger.dev/sdk";
import { decryptSecret, getRecord } from "../secret-store.mjs";

export const verifySecret = task({
  id: "ssc-spike-e-verify-secret",
  run: async (payload: { secretId: string; workspaceId: string; appId: string }) => {
    const record = await getRecord(payload.secretId);
    if (!record) throw new Error("Encrypted record missing");
    const plaintext = await decryptSecret(payload.secretId, payload);
    const digest = crypto.createHash("sha256").update(plaintext).digest("hex");
    if (digest !== record.digest) throw new Error("Decrypted secret digest mismatch");
    return {
      result: "SPIKE_E_TASK_PASS",
      secretId: payload.secretId,
      scopeVerified: true,
      digestVerified: true,
      plaintextPrinted: false,
    };
  },
});
