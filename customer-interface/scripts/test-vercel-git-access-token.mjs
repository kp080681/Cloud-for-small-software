// One-off diagnostic, NOT production code: answers exactly one question —
// does this Vercel account accept gitAccessToken alongside gitSource? This
// is deliberately separate from execute-build.ts's real deployment-creation
// call: it never touches the real deployment row, never claims a provider
// operation, and makes its own standalone request so a rejection here can't
// affect the app's actual state at all.
//
// If Vercel accepts it (a real deployment gets created, or at minimum the
// request isn't rejected for account-eligibility reasons), building the
// real, secure, properly-scoped version into execute-build.ts is worth
// doing. If Vercel rejects it with an account/plan-related error, that's
// the actual next step to resolve with Vercel directly, before any code
// gets written for this.
//
// Usage: DEPLOYMENT_ID=<uuid> node --env-file=.env.local scripts/test-vercel-git-access-token.mjs
import { connectDatabase } from "../src/server/db.mjs";
import { createGitHubAppAuth } from "../src/server/github-app.mjs";

for (const name of ["DEPLOYMENT_ID", "VERCEL_TOKEN"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const db = await connectDatabase();
try {
  const deploymentId = process.env.DEPLOYMENT_ID;
  const lookup = await db.query(
    `SELECT d.source_commit_sha, rt.provider_project_name, rt.provider_project_id,
            gr.full_name, gr.github_repository_id, gi.github_installation_id
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
       JOIN app_runtimes rt ON rt.app_id = d.app_id
       JOIN github_repositories gr ON gr.id = a.repository_id
       JOIN github_installations gi ON gi.id = gr.github_installation_id
      WHERE d.id = $1`,
    [deploymentId],
  );
  const row = lookup.rows[0];
  if (!row) throw new Error(`No deployment (joined through app/repository/installation) found for id: ${deploymentId}`);

  const [org, repo] = row.full_name.split("/");
  console.log(`Generating a repo-scoped installation token for ${row.full_name}...`);

  const auth = createGitHubAppAuth();
  const installationAuth = await auth({
    type: "installation",
    installationId: Number(row.github_installation_id),
    repositoryIds: [Number(row.github_repository_id)],
  });

  console.log("Token generated (not printed). Trying Vercel deployment creation with gitAccessToken...");

  const response = await fetch(`https://api.vercel.com/v13/deployments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: row.provider_project_name,
      project: row.provider_project_id,
      target: "production",
      gitSource: { type: "github", org, repo, ref: row.source_commit_sha },
      gitAccessToken: installationAuth.token,
      projectSettings: { framework: "node" },
    }),
  });

  const text = await response.text();
  console.log("status:", response.status, response.statusText);
  console.log("body:", text);
} finally {
  await db.end();
}
