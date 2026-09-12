import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  INTERNAL_RESUME_ACCEPTANCE_EVENT,
  INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  internalResumeAcceptanceHookEnabled,
  maybeInterruptInternalResumeAcceptance,
  recordInternalResumeAcceptanceInterruption,
} from "../src/internal-resume-acceptance-hook.mjs";

const root = path.resolve(import.meta.dirname, "..");

class FakeDb {
  constructor() {
    this.events = [];
    this.queries = [];
    this.ended = false;
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    this.queries.push({ text, params });

    if (text.startsWith("SELECT id FROM deployment_events")) {
      const [deploymentId, eventType] = params;
      const event = this.events.find((row) => row.deployment_id === deploymentId && row.event_type === eventType);
      return { rowCount: event ? 1 : 0, rows: event ? [event] : [] };
    }

    if (text.startsWith("INSERT INTO deployment_events")) {
      const [deploymentId, eventType, message, metadata] = params;
      this.events.push({
        id: this.events.length + 1,
        deployment_id: deploymentId,
        event_type: eventType,
        message,
        metadata: JSON.parse(metadata),
      });
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unhandled fake query: ${text}`);
  }

  async end() {
    this.ended = true;
  }
}

test("internal resume acceptance hook is disabled by default and deployment scoped", () => {
  assert.equal(internalResumeAcceptanceHookEnabled({ deploymentId: "deployment-a", env: {} }), false);
  assert.equal(internalResumeAcceptanceHookEnabled({
    deploymentId: "deployment-a",
    env: {
      UTPLAVA_INTERNAL_RESUME_TEST_MODE: "true",
      UTPLAVA_INTERNAL_RESUME_TEST_DEPLOYMENT_ID: "deployment-b",
    },
  }), false);
  assert.equal(internalResumeAcceptanceHookEnabled({
    deploymentId: "deployment-a",
    env: {
      UTPLAVA_INTERNAL_RESUME_TEST_MODE: "true",
      UTPLAVA_INTERNAL_RESUME_TEST_DEPLOYMENT_ID: "deployment-a",
    },
  }), true);
});

test("wrong deployment does not connect to the database or interrupt", async () => {
  let connected = false;
  const result = await maybeInterruptInternalResumeAcceptance({
    deploymentId: "deployment-a",
    status: "ANALYZING",
    env: {
      UTPLAVA_INTERNAL_RESUME_TEST_MODE: "true",
      UTPLAVA_INTERNAL_RESUME_TEST_DEPLOYMENT_ID: "deployment-b",
    },
    connectDatabase: async () => {
      connected = true;
      return new FakeDb();
    },
  });

  assert.equal(result.interrupted, false);
  assert.equal(result.reason, "disabled");
  assert.equal(connected, false);
});

test("selected internal deployment records one non-terminal interruption at the safe analysis point", async () => {
  const db = new FakeDb();
  const result = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  });
  const replay = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  });

  assert.equal(result.interrupted, true);
  assert.equal(result.status, "ANALYZING");
  assert.equal(replay.interrupted, false);
  assert.equal(replay.reason, "already-interrupted");
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, INTERNAL_RESUME_ACCEPTANCE_EVENT);
  assert.equal(db.events[0].metadata.point, INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV);
  assert.equal(db.events[0].metadata.responseBodyStored, false);
  assert.equal(JSON.stringify(db.events).includes("secret"), false);
});

test("internal hook refuses non-analysis states instead of interrupting provider work", async () => {
  const db = new FakeDb();
  const result = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-a",
    status: "BUILDING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  });

  assert.equal(result.interrupted, false);
  assert.equal(result.reason, "not-safe-state");
  assert.equal(db.events.length, 0);
});

test("orchestrator acceptance interruption is after env verification and before provisioning", () => {
  const source = fs.readFileSync(path.join(root, "trigger", "orchestrate-deployment.ts"), "utf8");
  const envVerificationCall = source.indexOf("const envOutput=await child(\"ssc-control-plane-verify-env-requirements\"");
  const hookCall = source.indexOf("const internalResumeAcceptance=await maybeInterruptInternalResumeAcceptance");
  const provisioningBranch = source.indexOf('if(current.status==="PROVISIONING")');

  assert.match(source, /maybeInterruptInternalResumeAcceptance/);
  assert.ok(
    envVerificationCall > -1 && hookCall > -1 && envVerificationCall < hookCall,
    "acceptance interruption must happen after environment verification",
  );
  assert.ok(
    hookCall > -1 && provisioningBranch > -1 && hookCall < provisioningBranch,
    "acceptance interruption must happen before provisioning/provider work",
  );
  assert.match(source, /UTPLAVA_INTERNAL_RESUME_ACCEPTANCE_INTERRUPTED/);
});
