// One-off diagnostic, NOT production code: tests whether Vercel's basic
// file-upload deployment mechanism (POST /v2/files + files:[{file,sha,size}]
// on POST /v13/deployments, with NO gitSource and NO gitAccessToken) works
// for a repository Utplava's own GitHub App can read but that this Vercel
// account has no git-level access to — the same mechanism `vercel deploy`
// itself uses for every ordinary developer, per Vercel's own public KB
// article (no "platform accounts" restriction mentioned there, unlike the
// gitAccessToken and Platforms-SDK deployFiles() paths already ruled out).
//
// Deliberately isolated: creates its OWN throwaway Vercel project (a fresh
// name, no existing project ID), never touches the real app/deployment row
// for the repo being tested. Safe to delete the resulting Vercel project
// afterward regardless of outcome.
//
// Usage: DEPLOYMENT_ID=<uuid> node --env-file=.env.local scripts/test-vercel-file-upload-deploy.mjs
import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";
import { connectDatabase } from "../src/server/db.mjs";
import { createGitHubAppAuth } from "../src/server/github-app.mjs";

for (const name of ["DEPLOYMENT_ID", "VERCEL_TOKEN"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const db = await connectDatabase();
try {
  const deploymentId = process.env.DEPLOYMENT_ID;
  const lookup = await db.query(
    `SELECT d.source_commit_sha, gr.full_name, gr.github_repository_id, gi.github_installation_id
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
       JOIN github_repositories gr ON gr.id = a.repository_id
       JOIN github_installations gi ON gi.id = gr.github_installation_id
      WHERE d.id = $1`,
    [deploymentId],
  );
  const row = lookup.rows[0];
  if (!row) throw new Error(`No deployment (joined through app/repository/installation) found for id: ${deploymentId}`);

  const [owner, repo] = row.full_name.split("/");
  console.log(`Fetching file tree for ${row.full_name} @ ${row.source_commit_sha} via Utplava's own GitHub App...`);

  const auth = createGitHubAppAuth();
  const installationAuth = await auth({
    type: "installation",
    installationId: Number(row.github_installation_id),
    repositoryIds: [Number(row.github_repository_id)],
  });
  const octokit = new Octokit({ auth: installationAuth.token });

  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: row.source_commit_sha,
    recursive: "true",
  });
  const blobs = tree.tree.filter((entry) => entry.type === "blob");
  console.log(`Found ${blobs.length} files. Fetching content and computing Vercel's own SHA1 for each...`);

  const files = [];
  for (const entry of blobs) {
    const { data: blob } = await octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
    const content = Buffer.from(blob.content, blob.encoding);
    const sha = crypto.createHash("sha1").update(content).digest("hex");

    const uploadResponse = await fetch("https://api.vercel.com/v2/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
        "Content-Type": "application/octet-stream",
        "x-vercel-digest": sha,
      },
      body: content,
    });
    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      throw new Error(`Uploading ${entry.path} failed: ${uploadResponse.status} ${text}`);
    }
    files.push({ file: entry.path, sha, size: content.length });
  }
  console.log(`All ${files.length} files uploaded. Creating a throwaway test deployment (no gitSource, no gitAccessToken)...`);

  const deployResponse = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `utplava-test-file-upload-${Date.now()}`,
      target: "production",
      files,
      projectSettings: { framework: "node" },
    }),
  });

  const text = await deployResponse.text();
  console.log("status:", deployResponse.status, deployResponse.statusText);
  console.log("body:", text);
} finally {
  await db.end();
}
