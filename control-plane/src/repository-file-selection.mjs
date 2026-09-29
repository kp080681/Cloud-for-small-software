// Pure decision logic, extracted from execute-build.ts's file-upload
// fallback specifically so the root-directory prefix handling (an easy
// place to get an off-by-one or trailing-slash edge case wrong) gets real
// unit-test coverage, rather than only the type-check + live-testing
// boundary the rest of that file has. Given a repository's full git tree
// and a configured root directory, returns the subset of files under that
// root, with paths made relative to it — the exact set Vercel's own
// deployment root expects.
export function selectFilesUnderRoot(tree, rootDirectory) {
  const root = rootDirectory && rootDirectory !== "." ? rootDirectory.replace(/\/$/, "") : "";
  const prefix = root ? `${root}/` : "";
  return tree
    .filter((entry) => entry && entry.type === "blob" && typeof entry.path === "string" && entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
    .filter((entry) => entry.path.length > 0);
}
