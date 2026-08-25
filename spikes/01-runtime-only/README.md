# Spike A - Runtime-only deployment

This spike proves that Small Software Cloud can create and deploy a simple Next.js application to the runtime provider entirely through APIs.

## Test application

The test app lives in:

```text
spikes/01-runtime-only/test-app
```

It exposes:

```text
GET /api/health
```

Expected response:

```json
{
  "ok": true,
  "service": "ssc-spike-a-test-app",
  "marker": "<APP_BUILD_MARKER>"
}
```

The marker proves the runtime received the environment configuration intended for this deployment.

## Required local environment

```text
VERCEL_TOKEN
VERCEL_TEAM_ID            optional for personal-scope execution, recommended when using a team
SPIKE_GIT_SHA             required exact commit SHA
```

Optional:

```text
SPIKE_GITHUB_REPOSITORY   default kp080681/Cloud-for-small-software
SPIKE_GIT_REF             default main
SPIKE_PROJECT_NAME
APP_BUILD_MARKER
SPIKE_DELETE_AFTER_RUN    true to delete project after test
```

Never commit `VERCEL_TOKEN`.

## Run

From the repository root:

```bash
node spikes/01-runtime-only/run-spike.mjs
```

The runner performs:

```text
create project
  -> inject encrypted production environment variable
  -> deploy pinned GitHub commit
  -> poll deployment until terminal
  -> obtain HTTPS URL
  -> independently call /api/health
  -> verify service identity + exact marker
  -> report LIVE
```

If `SPIKE_DELETE_AFTER_RUN=true`, the project is deleted at the end. A repeated deletion is designed to treat provider 404 as already absent.

## Success criteria

Spike A passes when a run proves:

- project created through API
- no per-app Vercel dashboard configuration
- pinned commit used
- environment value injected through API
- deployment becomes READY
- HTTPS URL obtained through API
- independent health check verifies expected marker
- project deletion works safely

## Important

This is spike code, not production orchestration. It intentionally avoids the full control-plane database, Trigger.dev, KMS, GitHub App, and production state machine until their dedicated spike stages.
