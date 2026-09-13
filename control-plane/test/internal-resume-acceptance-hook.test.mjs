import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  INTERNAL_RESUME_ACCEPTANCE_EVENT,
  INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  internalResumeAcceptanceHookEnabled,
  internalResumeAcceptanceSelector,
  maybeInterruptInternalResumeAcceptance,
  recordInternalResumeAcceptanceInterruption,
} from "../src/internal-resume-acceptance-hook.mjs";

const root = path.resolve(import.meta.dirname, "..");

class FakeDb {
  constructor() {
    this.deployments = [
      { id: "deployment-a", workspace_id: "workspace-a", app_id: "app-a" },
      { id: "deployment-b", workspace_id: "workspace-a", app_id: "app-a" },
      { id: "deployment-c", workspace_id: "workspace-b", app_id: "app-a" },
      { id: "deployment-d", workspace_id: "workspace-a", app_id: "app-b" },
    ];
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

    if (text.startsWith("SELECT e.id FROM deployment_events e JOIN deployments d")) {
      const [workspaceId, appId, eventType, generation] = params;
      const event = this.events.find((row) => {
        const deployment = this.deployments.find((item) => item.id === row.deployment_id);
        return row.event_type === eventType
          && deployment?.workspace_id === workspaceId
          && deployment?.app_id === appId
          && (params.length < 4 || row.metadata?.generation === generation);
      });
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

test("app scoped selector matches only the configured workspace and app", () => {
  const env = {
    UTPLAVA_INTERNAL_RESUME_TEST_MODE: "true",
    UTPLAVA_INTERNAL_RESUME_TEST_WORKSPACE_ID: "workspace-a",
    UTPLAVA_INTERNAL_RESUME_TEST_APP_ID: "app-a",
    UTPLAVA_INTERNAL_RESUME_TEST_ONCE: "true",
  };

  assert.deepEqual(internalResumeAcceptanceSelector({
    deploymentId: "deployment-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    env: { ...env, UTPLAVA_INTERNAL_RESUME_TEST_GENERATION: "generation-a" },
  }), {
    enabled: true,
    selectorType: "app-once",
    workspaceId: "workspace-a",
    appId: "app-a",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    generation: "generation-a",
  });
  assert.equal(internalResumeAcceptanceHookEnabled({
    deploymentId: "deployment-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    env,
  }), true);
  assert.equal(internalResumeAcceptanceSelector({
    deploymentId: "deployment-c",
    workspaceId: "workspace-b",
    appId: "app-a",
    env,
  }).enabled, false);
  assert.equal(internalResumeAcceptanceSelector({
    deploymentId: "deployment-d",
    workspaceId: "workspace-a",
    appId: "app-b",
    env,
  }).enabled, false);
});

test("deployment id selector remains more specific than app scoped selector", () => {
  const env = {
    UTPLAVA_INTERNAL_RESUME_TEST_MODE: "true",
    UTPLAVA_INTERNAL_RESUME_TEST_DEPLOYMENT_ID: "deployment-b",
    UTPLAVA_INTERNAL_RESUME_TEST_WORKSPACE_ID: "workspace-a",
    UTPLAVA_INTERNAL_RESUME_TEST_APP_ID: "app-a",
    UTPLAVA_INTERNAL_RESUME_TEST_ONCE: "true",
    UTPLAVA_INTERNAL_RESUME_TEST_GENERATION: "ignored-by-deployment-selector",
  };

  assert.equal(internalResumeAcceptanceSelector({
    deploymentId: "deployment-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    env,
  }).enabled, false);
  assert.equal(internalResumeAcceptanceSelector({
    deploymentId: "deployment-b",
    workspaceId: "workspace-other",
    appId: "app-other",
    env,
  }).selectorType, "deployment");
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
  assert.equal(result.reason, "deployment-mismatch");
  assert.equal(connected, false);
});

test("wrong app scoped deployment does not connect to the database or interrupt", async () => {
  let connected = false;
  const result = await maybeInterruptInternalResumeAcceptance({
    deploymentId: "deployment-a",
    workspaceId: "workspace-b",
    appId: "app-a",
    status: "ANALYZING",
    env: {
      UTPLAVA_INTERNAL_RESUME_TEST_MODE: "true",
      UTPLAVA_INTERNAL_RESUME_TEST_WORKSPACE_ID: "workspace-a",
      UTPLAVA_INTERNAL_RESUME_TEST_APP_ID: "app-a",
      UTPLAVA_INTERNAL_RESUME_TEST_ONCE: "true",
      UTPLAVA_INTERNAL_RESUME_TEST_GENERATION: "generation-a",
    },
    connectDatabase: async () => {
      connected = true;
      return new FakeDb();
    },
  });

  assert.equal(result.interrupted, false);
  assert.equal(result.reason, "app-selector-mismatch");
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

test("app scoped one-time selector is consumed by exactly one matching deployment", async () => {
  const db = new FakeDb();
  const selector = {
    selectorType: "app-once",
    workspaceId: "workspace-a",
    appId: "app-a",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  };
  const first = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    selector,
  });
  const later = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-b",
    workspaceId: "workspace-a",
    appId: "app-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    selector,
  });

  assert.equal(first.interrupted, true);
  assert.equal(later.interrupted, false);
  assert.equal(later.reason, "selector-already-consumed");
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].deployment_id, "deployment-a");
  assert.equal(db.events[0].metadata.selectorType, "app-once");
  assert.equal(db.events[0].metadata.workspaceId, "workspace-a");
  assert.equal(db.events[0].metadata.appId, "app-a");
});

test("generation re-arms app scoped selector without consuming historical no-generation events", async () => {
  const db = new FakeDb();
  const legacySelector = {
    selectorType: "app-once",
    workspaceId: "workspace-a",
    appId: "app-a",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  };
  const generationSelector = {
    ...legacySelector,
    generation: "ui06b02-final",
  };

  const legacy = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    selector: legacySelector,
  });
  const rearmed = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-b",
    workspaceId: "workspace-a",
    appId: "app-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    selector: generationSelector,
  });

  assert.equal(legacy.interrupted, true);
  assert.equal(rearmed.interrupted, true);
  assert.equal(db.events.length, 2);
  assert.equal(db.events[0].metadata.generation, undefined);
  assert.equal(db.events[1].metadata.generation, "ui06b02-final");
});

test("same generation consumes once while different generation can interrupt once", async () => {
  const db = new FakeDb();
  const baseSelector = {
    selectorType: "app-once",
    workspaceId: "workspace-a",
    appId: "app-a",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
  };
  const first = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-a",
    workspaceId: "workspace-a",
    appId: "app-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    selector: { ...baseSelector, generation: "generation-1" },
  });
  const same = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-b",
    workspaceId: "workspace-a",
    appId: "app-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    selector: { ...baseSelector, generation: "generation-1" },
  });
  const different = await recordInternalResumeAcceptanceInterruption(db, {
    deploymentId: "deployment-b",
    workspaceId: "workspace-a",
    appId: "app-a",
    status: "ANALYZING",
    point: INTERNAL_RESUME_ACCEPTANCE_POINT_AFTER_ENV,
    selector: { ...baseSelector, generation: "generation-2" },
  });

  assert.equal(first.interrupted, true);
  assert.equal(same.interrupted, false);
  assert.equal(same.reason, "selector-already-consumed");
  assert.equal(different.interrupted, true);
  assert.deepEqual(db.events.map((event) => event.metadata.generation), ["generation-1", "generation-2"]);
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
