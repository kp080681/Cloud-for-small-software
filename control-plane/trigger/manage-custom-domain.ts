import { schedules, task } from "@trigger.dev/sdk";
import { Resolver } from "node:dns/promises";
import pg from "pg";
import {
  CUSTOM_DOMAIN_STATUS as S,
  decideStatus,
  hostLabel,
  OWNERSHIP_PROOF_PREFIX,
  ownershipProofValue,
  recognizeDnsProvider,
  recordsForName,
  verificationRecords,
} from "../src/custom-domain.mjs";
import { assertSafeWorkloadUrl, publicAccessRequestInit } from "../src/workload-http.mjs";

// Custom domains (2026-10-30). One task does all three provider operations
// for a domain row in app_custom_domains:
//   attach: add the domain (and, for an apex, www as a redirect) to the app's
//           Vercel project, then check it
//   check:  ask Vercel and public DNS how far the customer's setup has got,
//           store the records still to add/delete and a plain status
//   remove: take the domain(s) off the project and mark the row REMOVED
// Runs one at a time (concurrency total 1) so a check can never race a
// remove for the same row. The dashboard only writes rows and starts this
// task by id; it never talks to the provider itself.

const { Client } = pg;
const API = "https://api.vercel.com";
const VERCEL_REQUEST_TIMEOUT_MS = 25_000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function teamQuery(extra: Record<string, string> = {}) {
  const query = new URLSearchParams(extra);
  if (process.env.VERCEL_TEAM_ID) query.set("teamId", process.env.VERCEL_TEAM_ID);
  const text = query.toString();
  return text ? `?${text}` : "";
}

async function vercel(path: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
  if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERCEL_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function projectDomainPath(projectId: string, name: string) {
  return `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}`;
}

// Adds `name` to the project unless it's already there. Returns Vercel's
// project-domain object, or a failure the customer can act on.
async function ensureProjectDomain(projectId: string, name: string, redirect?: string) {
  const existing = await vercel(`${projectDomainPath(projectId, name)}${teamQuery()}`);
  if (existing.status === 200 && existing.body) return { ok: true as const, domain: existing.body };
  const body: Record<string, unknown> = { name };
  if (redirect) Object.assign(body, { redirect, redirectStatusCode: 308 });
  const created = await vercel(`/v10/projects/${encodeURIComponent(projectId)}/domains${teamQuery()}`, { method: "POST", body: JSON.stringify(body) });
  if (created.status >= 200 && created.status < 300 && created.body) return { ok: true as const, domain: created.body };
  const providerCode = String(created.body?.error?.code ?? "");
  if (created.status === 409 || /in_use|already/i.test(providerCode)) {
    return { ok: false as const, code: "DOMAIN_IN_USE", message: `${name} is already connected to another website or app. If it's yours (for example, a project you host elsewhere), remove the domain there first, then try again here. Or use a subdomain such as app.${name}.` };
  }
  if (created.status === 400 || created.status === 422) {
    return { ok: false as const, code: "DOMAIN_REJECTED", message: `${name} can't be used. Check the spelling, and that it's a domain you've registered.` };
  }
  if (created.status === 403) {
    return { ok: false as const, code: "DOMAIN_FORBIDDEN", message: `${name} can't be connected right now. Contact support and we'll sort it out.` };
  }
  throw new Error(`Vercel add-domain failed: ${created.status} ${providerCode}`.slice(0, 200));
}

async function removeProjectDomain(projectId: string, name: string) {
  const result = await vercel(`${projectDomainPath(projectId, name)}${teamQuery()}`, { method: "DELETE" });
  if (result.status === 404 || (result.status >= 200 && result.status < 300)) return;
  throw new Error(`Vercel remove-domain failed: ${result.status}`);
}

function publicResolver() {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  return resolver;
}

async function quiet<T>(work: Promise<T>, fallback: T): Promise<T> {
  try { return await work; } catch { return fallback; }
}

async function currentRecords(resolver: Resolver, name: string) {
  const [a, aaaa, cname] = await Promise.all([
    quiet(resolver.resolve4(name), [] as string[]),
    quiet(resolver.resolve6(name), [] as string[]),
    quiet(resolver.resolveCname(name), [] as string[]),
  ]);
  return { a, aaaa, cname };
}

async function nameserversFor(resolver: Resolver, apexName: string) {
  return quiet(resolver.resolveNs(apexName), [] as string[]);
}

async function httpsReachable(domain: string) {
  const url = `https://${domain}/`;
  try {
    assertSafeWorkloadUrl(url, { allowedHostnameSuffixes: [domain] });
    const response = await fetch(url, publicAccessRequestInit({ signal: AbortSignal.timeout(8000), userAgent: BROWSER_UA }) as RequestInit);
    try { await response.body?.cancel(); } catch {}
    const location = response.headers.get("location") || "";
    const toVercelLogin = /(^|\.)vercel\.com$/i.test((() => { try { return new URL(location, url).hostname; } catch { return ""; } })());
    return response.status >= 200 && response.status < 400 && !toVercelLogin;
  } catch {
    return false; // DNS not there yet, certificate still issuing, timeout
  }
}

async function loadRow(db: pg.Client, domainId: string) {
  const result = await db.query(
    `SELECT cd.*, rt.provider, rt.provider_project_id
       FROM app_custom_domains cd
       JOIN apps a ON a.id = cd.app_id AND a.workspace_id = cd.workspace_id
       LEFT JOIN app_runtimes rt ON rt.app_id = cd.app_id
      WHERE cd.id = $1`,
    [domainId],
  );
  return result.rows[0] ?? null;
}

async function fail(db: pg.Client, domainId: string, code: string, message: string) {
  await db.query(
    `UPDATE app_custom_domains SET status = 'FAILED', problem_code = $2, problem = $3, last_checked_at = now(), updated_at = now()
      WHERE id = $1 AND status NOT IN ('REMOVING', 'REMOVED')`,
    [domainId, code, message],
  );
  return { status: S.FAILED, code };
}

// A domain that was live on Utplava in ANOTHER workspace may still point at
// Utplava after that app was deleted. Before connecting it to a new
// workspace, its owner must prove control with a one-time TXT record, so
// nobody can pick up a domain someone else forgot to unpoint.
async function proofRequired(db: pg.Client, row: any) {
  const prior = await db.query(
    `SELECT 1 FROM app_custom_domains
      WHERE status = 'REMOVED' AND active_at IS NOT NULL AND workspace_id <> $2
        AND (domain = $1 OR domain = 'www.' || $1 OR 'www.' || domain = $1)
      LIMIT 1`,
    [row.domain, row.workspace_id],
  );
  return prior.rowCount > 0;
}

async function zoneApex(resolver: Resolver, name: string) {
  const labels = name.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    const ns = await quiet(resolver.resolveNs(candidate), [] as string[]);
    if (ns.length) return { apex: candidate, nameservers: ns };
  }
  return { apex: name, nameservers: [] as string[] };
}

async function ownershipProven(db: pg.Client, row: any) {
  if (!(await proofRequired(db, row))) return true;
  const resolver = publicResolver();
  const proofName = `${OWNERSHIP_PROOF_PREFIX}.${row.domain}`;
  const expected = ownershipProofValue(row.id);
  const txt = await quiet(resolver.resolveTxt(proofName), [] as string[][]);
  if (txt.some((chunks) => chunks.join("") === expected)) return true;
  const { apex, nameservers } = await zoneApex(resolver, row.domain);
  const provider = recognizeDnsProvider(nameservers);
  const record = { type: "TXT", name: hostLabel(proofName, apex), value: expected, fqdn: proofName, purpose: "ownership" };
  await db.query(
    `UPDATE app_custom_domains
        SET records = $2::jsonb, conflicts = '[]'::jsonb, dns_provider_key = $3, dns_provider_name = $4,
            problem_code = 'OWNERSHIP_PROOF_NEEDED',
            problem = $5, last_checked_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [row.id, JSON.stringify([record]), provider.key, provider.name,
     `This domain was connected to a different Utplava account before. To prove it's yours, add the TXT record below${provider.name ? ` in ${provider.name}` : ""}. Utplava connects it as soon as the record shows up.`],
  );
  return false;
}

async function attach(db: pg.Client, row: any) {
  if (row.provider !== "vercel" || !row.provider_project_id) {
    return fail(db, row.id, "APP_NOT_DEPLOYED", "Deploy this app first, then connect your domain.");
  }
  if (!(await ownershipProven(db, row))) return { status: S.PENDING, proofNeeded: true };
  const primary = await ensureProjectDomain(row.provider_project_id, row.domain);
  if (!primary.ok) return fail(db, row.id, primary.code, primary.message);
  const apexName = String(primary.domain?.apexName || row.domain).toLowerCase();
  let includeWww = false;
  if (apexName === row.domain) {
    // www follows the main domain (308 redirect). If it's taken elsewhere the
    // main domain still works, so that's not a failure.
    const www = await ensureProjectDomain(row.provider_project_id, `www.${row.domain}`, row.domain);
    includeWww = www.ok;
  }
  await db.query(
    `UPDATE app_custom_domains SET apex_name = $2, include_www = $3, status = 'NEEDS_DNS', problem_code = NULL, problem = NULL, updated_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [row.id, apexName, includeWww],
  );
  return check(db, { ...row, apex_name: apexName, include_www: includeWww, status: S.NEEDS_DNS });
}

async function check(db: pg.Client, row: any) {
  if (row.provider !== "vercel" || !row.provider_project_id) {
    return fail(db, row.id, "APP_NOT_DEPLOYED", "This app isn't deployed any more. Deploy it again, then reconnect your domain.");
  }
  const projectId = row.provider_project_id;
  let projectDomain = await vercel(`${projectDomainPath(projectId, row.domain)}${teamQuery()}`);
  if (projectDomain.status === 404) {
    // Taken off the project outside Utplava; put it back.
    const again = await ensureProjectDomain(projectId, row.domain);
    if (!again.ok) return fail(db, row.id, again.code, again.message);
    projectDomain = { status: 200, body: again.domain };
  }
  if (projectDomain.status !== 200) throw new Error(`Vercel get-domain failed: ${projectDomain.status}`);
  let verified = Boolean(projectDomain.body?.verified);
  let verification = projectDomain.body?.verification ?? [];
  if (!verified) {
    const attempt = await vercel(`${projectDomainPath(projectId, row.domain)}/verify${teamQuery()}`, { method: "POST" });
    if (attempt.status === 200 && attempt.body?.verified) {
      verified = true;
      verification = [];
    }
  }

  const apexName = String(row.apex_name || projectDomain.body?.apexName || row.domain).toLowerCase();
  const names = row.include_www ? [row.domain, `www.${row.domain}`] : [row.domain];
  const resolver = publicResolver();
  const [nameservers, ...perName] = await Promise.all([
    nameserversFor(resolver, apexName),
    ...names.map(async (name) => {
      const [config, current] = await Promise.all([
        vercel(`/v6/domains/${encodeURIComponent(name)}/config${teamQuery({ projectIdOrName: projectId })}`),
        currentRecords(resolver, name),
      ]);
      return { name, config: config.status === 200 ? config.body : null, current };
    }),
  ]);

  const provider = recognizeDnsProvider(nameservers as string[]);
  const records: any[] = verificationRecords(verified ? [] : verification, apexName);
  const conflicts: any[] = [];
  let primaryConfigured = false;
  let wwwReady = false;
  for (const entry of perName) {
    const configured = entry.config ? entry.config.misconfigured === false : false;
    if (entry.name === row.domain) primaryConfigured = configured;
    else wwwReady = configured;
    if (configured) continue; // already reaching Vercel; nothing to change
    const { add, remove } = recordsForName({ name: entry.name, apexName, config: entry.config, current: entry.current });
    records.push(...add.map((record) => ({ ...record, purpose: entry.name === row.domain ? "main" : "www" })));
    conflicts.push(...remove);
  }

  const reachable = verified && primaryConfigured ? await httpsReachable(row.domain) : false;
  const status = decideStatus({ verified, primaryConfigured, httpsReachable: reachable });

  // A domain that was live and now isn't must be seen failing twice in a row
  // (a DNS blip shouldn't flip the app's main link back).
  if (row.status === S.ACTIVE && status !== S.ACTIVE && row.problem_code !== "STOPPED_RESOLVING") {
    await db.query(
      `UPDATE app_custom_domains SET problem_code = 'STOPPED_RESOLVING', last_checked_at = now(), updated_at = now() WHERE id = $1 AND status = 'ACTIVE'`,
      [row.id],
    );
    return { status: S.ACTIVE, suspect: true };
  }

  let problemCode: string | null = null;
  let problem: string | null = null;
  if (status === S.NEEDS_DNS) {
    if (row.status === S.ACTIVE) {
      problemCode = "STOPPED_RESOLVING";
      problem = `${row.domain} stopped pointing to Utplava, so visitors can't reach your app there. Add the records below again${provider.name ? ` in ${provider.name}` : ""}.`;
    } else if (provider.key === "cloudflare" && perName.some((entry) => entry.config?.configuredBy === "http")) {
      problemCode = "CLOUDFLARE_PROXIED";
      problem = "Your records are in Cloudflare but the orange cloud (proxy) is on. Switch each one to DNS only (grey cloud).";
    } else if (conflicts.length) {
      problemCode = "OLD_RECORDS";
      problem = `Your domain still points somewhere else. Delete the old record${conflicts.length > 1 ? "s" : ""} listed below and add the new one${records.length > 1 ? "s" : ""}.`;
    }
  }

  await db.query(
    `UPDATE app_custom_domains
        SET status = $2, apex_name = $3, dns_provider_key = $4, dns_provider_name = $5,
            records = $6::jsonb, conflicts = $7::jsonb, www_ready = $8,
            problem_code = $9, problem = $10, last_checked_at = now(),
            active_at = CASE WHEN $2 = 'ACTIVE' THEN COALESCE(active_at, now()) ELSE active_at END,
            updated_at = now()
      WHERE id = $1 AND status NOT IN ('REMOVING', 'REMOVED', 'FAILED')`,
    [row.id, status, apexName, provider.key, provider.name, JSON.stringify(records), JSON.stringify(conflicts), wwwReady, problemCode, problem],
  );
  return { status, verified, primaryConfigured, wwwReady };
}

async function remove(db: pg.Client, row: any) {
  if (row.provider === "vercel" && row.provider_project_id) {
    // www only if Utplava added it: if it was already taken by another
    // project, deleting it here would break that project.
    const names = row.include_www ? [row.domain, `www.${row.domain}`] : [row.domain];
    for (const name of names) await removeProjectDomain(row.provider_project_id, name);
  }
  await db.query(
    `UPDATE app_custom_domains SET status = 'REMOVED', removed_at = COALESCE(removed_at, now()), updated_at = now() WHERE id = $1`,
    [row.id],
  );
  return { status: S.REMOVED };
}

export const manageCustomDomain = task({
  id: "ssc-control-plane-manage-custom-domain",
  concurrency: { total: 1 },
  retry: { maxAttempts: 3, minTimeoutInMs: 3000, maxTimeoutInMs: 20000, factor: 2, randomize: true },
  run: async (payload: { domainId: string; action: "attach" | "check" | "remove" }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const row = await loadRow(db, payload.domainId);
      if (!row) return { result: "NOT_FOUND" };
      if (row.status === S.REMOVED) return { result: "ALREADY_REMOVED" };
      if (payload.action === "remove" || row.status === S.REMOVING) return { result: "REMOVED", ...(await remove(db, row)) };
      if (row.status === S.FAILED) return { result: "FAILED_NOOP" };
      if (row.status === S.PENDING) return { result: "ATTACHED", ...(await attach(db, row)) };
      return { result: "CHECKED", ...(await check(db, row)) };
    } finally {
      await db.end();
    }
  },
});

// Background re-checks so the customer doesn't have to keep pressing Check:
// every 10 minutes for domains still being set up (hourly once they're more
// than a day old), and every 6 hours for live domains, to notice one that
// stopped working. Domains never finished within 14 days are released.
export const recheckCustomDomains = schedules.task({
  id: "ssc-control-plane-recheck-custom-domains",
  cron: "*/10 * * * *",
  run: async () => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const due = await db.query(
        `SELECT id, status FROM app_custom_domains
          WHERE (status IN ('PENDING', 'NEEDS_DNS', 'SECURING')
                 AND created_at > now() - interval '14 days'
                 AND (last_checked_at IS NULL
                      OR last_checked_at < now() - CASE WHEN created_at < now() - interval '1 day' THEN interval '55 minutes' ELSE interval '9 minutes' END))
             OR (status = 'ACTIVE' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '6 hours'))
             OR (status = 'REMOVING' AND updated_at < now() - interval '10 minutes')
          ORDER BY last_checked_at NULLS FIRST
          LIMIT 25`,
      );
      // A domain nobody finished setting up in 14 days is released, so a
      // typo (or someone else's domain) can't stay reserved forever.
      await db.query(
        `UPDATE app_custom_domains SET status = 'REMOVING', problem_code = 'NOT_SET_UP_IN_TIME', updated_at = now()
          WHERE status IN ('PENDING', 'NEEDS_DNS', 'FAILED') AND active_at IS NULL AND created_at < now() - interval '14 days'`,
      );
      for (const row of due.rows) {
        const action = row.status === "REMOVING" ? "remove" : row.status === "PENDING" ? "attach" : "check";
        await manageCustomDomain.trigger({ domainId: row.id, action }, { tags: [`custom-domain:${row.id}`, "custom-domain-recheck"] });
      }
      return { queued: due.rowCount };
    } finally {
      await db.end();
    }
  },
});
