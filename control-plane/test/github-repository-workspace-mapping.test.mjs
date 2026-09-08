import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function readControlPlaneFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("GitHub repository mapping migration removes stale global repository uniqueness", () => {
  const migration = readControlPlaneFile("db/019_drop_global_github_repository_uniqueness.sql");

  assert.match(migration, /pg_constraint/);
  assert.match(migration, /c\.conkey/);
  assert.match(migration, /github_installation_id', 'github_repository_id/);
  assert.match(migration, /ALTER TABLE public\.github_repositories DROP CONSTRAINT/);
  assert.match(migration, /DROP INDEX IF EXISTS public\./);
  assert.match(migration, /github_repositories_workspace_installation_repo_idx/);
  assert.match(migration, /workspace_id, github_installation_id, github_repository_id/);
});
