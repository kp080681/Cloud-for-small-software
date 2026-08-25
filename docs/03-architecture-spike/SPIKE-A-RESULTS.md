# Spike A Results - Runtime-only deployment

## Status

**PASSED**

Spike A successfully proved the runtime-only gold path for a simple Next.js application using Small Software Cloud spike code and the Vercel API.

## Successful run

Source repository:

```text
kp080681/Cloud-for-small-software
```

Pinned commit:

```text
f94d3481457f7bb5d7fcc3ddc4ade2d6dce0cd18
```

Project ID:

```text
prj_KyZBeC4Um19NrkVwPg1kVWBRiujN
```

Deployment ID:

```text
dpl_4mc8GsG2eAybjyh42p7Z54d1JuEg
```

Deployment URL:

```text
https://ssc-spike-a-1787659731740-qvm88gduh-kp080681s-projects.vercel.app
```

The project was deleted successfully at the end of the run, so the URL is not expected to remain available.

## Verified health response

```json
{
  "ok": true,
  "service": "ssc-spike-a-test-app",
  "marker": "spike-a-1787659731740"
}
```

The marker was injected through the Vercel environment-variable API and independently verified through the deployed application's health endpoint.

This proves the verifier reached the intended application deployment rather than merely receiving an arbitrary HTTP success response.

## Measured timings

```text
Runtime project provisioning:       2.336 s
Protection configuration:           0.387 s
Environment configuration:          1.026 s
Build + deployment:                 37.197 s
Independent health verification:    0.792 s
```

Approximate orchestration time from runtime creation start to verified LIVE:

```text
41.7 seconds
```

This is an initial uncached spike measurement, not a performance target.

## Gold path proven

```text
Create Vercel project through API
        ->
Configure automation protection bypass through API
        ->
Inject encrypted production environment variable through API
        ->
Deploy exact pinned GitHub commit through API
        ->
Poll deployment to READY
        ->
Obtain HTTPS deployment URL
        ->
Call protected /api/health using automation bypass
        ->
Verify service identity + expected marker
        ->
LIVE
        ->
Delete project through API
```

## Manual provider-console test

No per-application Vercel dashboard configuration was required for the successful run.

The only manual Vercel setup was platform-level credential preparation:

- user/team already existed
- API token created once for the spike

This is allowed by the Node 03 spike plan.

## Acceptance criteria result

1. Repository and branch resolve to exact commit SHA - **PASS**
2. Runtime resource created through API - **PASS**
3. Test environment variable injected through API - **PASS**
4. Build/deployment triggered through API - **PASS**
5. No per-app provider dashboard setup required - **PASS**
6. Provider deployment status observable programmatically - **PASS**
7. Candidate HTTPS URL retrieved programmatically - **PASS**
8. Independent health check succeeds - **PASS**
9. Deployment reached LIVE in spike orchestration - **PASS**
10. Resource deleted safely through API - **PASS**
11. Repeated-delete reconciliation behaviour - **IMPLEMENTED IN ADAPTER; explicit second-delete run still belongs in failure/retry spike**

## Attempt history

### Attempt 1 - provider dependency security gate

Result:

```text
FAILED
```

The original test app used Next.js 15.5.2.

Vercel successfully:

- created the project
- received the environment configuration
- cloned the pinned commit
- installed dependencies
- compiled the Next.js application
- generated the health route
- completed the build

Vercel then refused deployment because the Next.js version was known vulnerable.

Finding:

> Provider-side dependency security checks can block a technically successful build before publication.

Action:

The spike app was upgraded to a patched Next.js maintenance release.

This was a useful security finding rather than an orchestration defect.

### Attempt 2 - deployment protection blocked anonymous verifier

Result:

```text
Deployment READY
Health check FAILED with HTTP 401
```

The deployed application's health endpoint was independently confirmed to return the correct response when accessed through authenticated Vercel tooling.

Finding:

> Candidate deployment URLs may be protected and cannot be assumed publicly readable by an automated verifier.

Action:

The runtime adapter was changed to use Vercel's supported automation protection-bypass mechanism rather than weakening deployment protection.

### Attempt 3 - bypass response parsing mismatch

Result:

```text
FAILED before deployment
cleanup PASSED
```

Vercel generated the protection-bypass configuration, but the spike parser incorrectly assumed a `{ secret: ... }` response shape.

Finding:

> Provider response shapes must be adapter concerns and must be tested against live APIs rather than inferred from conceptual documentation.

The provider returned a protection-bypass map keyed by the generated credential.

Action:

Adapter parser updated without logging or persisting the bypass secret.

The failed run also proved safe project deletion:

```text
deleted = true
```

### Attempt 4 - full success

Result:

```text
LIVE
cleanup deleted = true
```

All runtime-only gold-path operations completed through code.

## Architecture findings

### 1. Vercel is viable for the Next.js runtime orchestration spike

The APIs expose sufficient primitives for:

- project creation
- Git repository linkage
- pinned revision deployment
- encrypted environment configuration
- deployment state polling
- HTTPS candidate URL retrieval
- deployment protection automation access
- resource deletion

This validates the basic `RuntimeProvider` abstraction for the internal proof stage.

### 2. Health verification must understand deployment protection

The verifier cannot simply perform an anonymous HTTP GET and assume every provider candidate URL is public.

The runtime adapter/provider capability model should expose whether protected candidate access requires a verifier credential.

The product-level health verifier should remain provider-neutral while the adapter supplies the required safe request authorization.

### 3. Provider security policy is part of deployment outcome

A successful application build may still be rejected by provider security policy.

This should eventually normalize into an internal failure category distinct from compilation failure, for example:

```text
PROVIDER_SECURITY_POLICY_REJECTED
```

### 4. Exact commit pinning is working

Vercel deployment metadata showed the exact SHA supplied by the spike.

This validates the core reproducibility requirement.

### 5. Environment injection is working

The deployment-specific marker reached the running application and was returned by `/api/health`.

This proves the runtime configuration API path works.

### 6. Safe deletion works on the primary path

The successful run deleted the Vercel project through the API after verification.

A previous failed run also deleted its partially configured runtime cleanly.

This is important evidence for cleanup/reconciliation work in Spike B.

## Security observations

- Vercel API token remained local and was not committed to GitHub.
- Automation bypass credential was not logged by the runner.
- Environment variable was configured as an encrypted Vercel environment variable.
- Deployment protection remained enabled.
- Health verification used the provider-supported automation bypass instead of disabling protection.
- Customer code was built by the provider rather than executed inside the control-plane process.

## Open items moved to Spike B / security track

Spike A does **not** prove:

- duplicate create idempotency
- timeout reconciliation
- worker/task crash recovery
- repeated delete behaviour against already-absent runtime in a live run
- malicious workload isolation
- external arbitrary-code safety
- provider abuse controls

Those remain explicitly open.

## Decision

**Spike A passes.**

The fundamental runtime-only deployment mechanism is technically viable:

> exact GitHub commit -> programmatic runtime provisioning -> environment configuration -> build/deploy -> protected HTTPS health verification -> LIVE -> safe deletion

Proceed to **Spike B - Failure, retry, idempotency, and reconciliation** before adding PostgreSQL or broader product functionality.
