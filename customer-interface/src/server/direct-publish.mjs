// Direct publishing (2026-11-06): put an app online without the person
// ever touching GitHub. They upload files or paste HTML (dashboard), or an
// AI chat sends the files (MCP publish_files). Utplava keeps the code in a
// private repository in its own GitHub organisation, then runs the exact
// same analyse -> readiness -> start pipeline as every other app.
//
// Isolation: those repositories are rows in github_repositories for ONE
// workspace with managed_by_utplava = true. The organisation's GitHub App
// installation is never linked to any workspace (workspace_github_
// installations), so no workspace can list or select another's code, and
// push webhooks from Utplava's own commits match no app (no double deploy).
//
// Everything a stranger sends is checked BEFORE anything is created:
// size and count limits, safe paths, web file types only, leaked secret
// keys, and obvious phishing pages. Nothing from the files is echoed back
// in errors except the file's own (validated) path.

import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";
import { getAuthorizedWorkspace } from "./customer-workspaces.mjs";
import { createAppOctokit } from "./github-app.mjs";
import { enforceRateLimit } from "../shared/control-plane/rate-limit.mjs";
import { enforceActiveAppLimit } from "../shared/control-plane/workspace-resource-policy.mjs";

export const PUBLISH_LIMITS = Object.freeze({
  maxFiles: 50,
  maxTotalBytes: 2 * 1024 * 1024,
  maxPathLength: 160,
  maxDepth: 6,
  perHour: 10,
  perDay: 30,
  // Across every account: bounds what a burst of throwaway accounts can do
  // to Utplava's GitHub organisation and build budget.
  globalPerHour: 200,
});

const TEXT_EXTENSIONS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "txt", "md",
  "xml", "svg", "map", "webmanifest", "csv",
]);
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf",
]);

export class PublishError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function publisherConfig(env = process.env) {
  const org = env.UTPLAVA_PUBLISH_GITHUB_ORG;
  const token = env.UTPLAVA_PUBLISH_GITHUB_TOKEN;
  if (!org || !token || !/^[A-Za-z0-9-]{1,39}$/.test(org)) {
    throw new PublishError(
      "PUBLISH_NOT_CONFIGURED",
      "Uploading files isn't switched on yet. Email contact@dealup.co.in and we'll put your app online with you.",
      503,
    );
  }
  return { org, token };
}

export function isPublisherAccount(login, env = process.env) {
  const org = env.UTPLAVA_PUBLISH_GITHUB_ORG;
  return Boolean(org && login && String(login).toLowerCase() === org.toLowerCase());
}

// ---------- name ----------

export function validateAppName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
    throw new PublishError(
      "PUBLISH_NAME_INVALID",
      "Give your app a name of 2 to 40 letters or numbers, like \"Bakery site\".",
    );
  }
  return name;
}

export function slugForName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
}

// ---------- files ----------

function extensionOf(path) {
  const base = path.split("/").at(-1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// Returns a clean relative path or throws. Rejects anything that could
// escape the app's folder or smuggle in tooling/config files.
export function normalizeUploadPath(raw) {
  if (typeof raw !== "string") throw new PublishError("PUBLISH_PATH_INVALID", "A file has no name.");
  let path = raw.replace(/\\/g, "/").trim();
  while (path.startsWith("./")) path = path.slice(2);
  const shown = path.slice(0, 80);
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.length > PUBLISH_LIMITS.maxPathLength) {
    throw new PublishError("PUBLISH_PATH_INVALID", `This file name can't be used: ${shown}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>:"|?*]/.test(path)) {
    throw new PublishError("PUBLISH_PATH_INVALID", `This file name has characters that can't be used: ${shown}`);
  }
  const parts = path.split("/");
  if (parts.length > PUBLISH_LIMITS.maxDepth) {
    throw new PublishError("PUBLISH_PATH_INVALID", `This file is in too many folders: ${shown}`);
  }
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new PublishError("PUBLISH_PATH_INVALID", `This file name can't be used: ${shown}`);
    }
    if (part === "node_modules") {
      throw new PublishError("PUBLISH_NODE_MODULES", "Leave out the node_modules folder. Utplava installs it for you.");
    }
    if (part.startsWith(".")) {
      if (/^\.env/i.test(part)) {
        throw new PublishError(
          "PUBLISH_ENV_FILE",
          "Leave out .env files: they hold your private keys. Add those keys on your app's page in Utplava instead, after it's uploaded.",
        );
      }
      throw new PublishError("PUBLISH_HIDDEN_FILE", `Leave out hidden files and folders like ${part}.`);
    }
  }
  return parts.join("/");
}

function decodeContent(file, path) {
  const encoding = file?.encoding === "base64" ? "base64" : "utf8";
  if (typeof file?.content !== "string") {
    throw new PublishError("PUBLISH_FILE_EMPTY", `${path} has no content.`);
  }
  if (encoding === "base64" && !/^[A-Za-z0-9+/=\s]*$/.test(file.content)) {
    throw new PublishError("PUBLISH_FILE_INVALID", `${path} couldn't be read.`);
  }
  return Buffer.from(file.content, encoding);
}

// If every file sits in one top-level folder (someone uploaded "my-site/"),
// publish what's inside it.
function stripCommonFolder(entries) {
  if (entries.length === 0) return entries;
  const first = entries[0].path.split("/");
  if (first.length < 2) return entries;
  const folder = first[0];
  if (!entries.every((e) => e.path.startsWith(`${folder}/`))) return entries;
  return entries.map((e) => ({ ...e, path: e.path.slice(folder.length + 1) }));
}

export function validatePublishFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PublishError("PUBLISH_NO_FILES", "Add your app's files, or paste your HTML.");
  }
  if (files.length > PUBLISH_LIMITS.maxFiles) {
    throw new PublishError(
      "PUBLISH_TOO_MANY_FILES",
      `That's ${files.length} files. Uploads can have up to ${PUBLISH_LIMITS.maxFiles}. For a bigger app, connect GitHub instead.`,
    );
  }
  let entries = [];
  let totalBytes = 0;
  const seen = new Set();
  for (const file of files) {
    const path = normalizeUploadPath(file?.path);
    const ext = extensionOf(path);
    if (!TEXT_EXTENSIONS.has(ext) && !BINARY_EXTENSIONS.has(ext)) {
      throw new PublishError(
        "PUBLISH_FILE_TYPE",
        `${path} isn't a file type Utplava can put online. Upload web files: HTML, CSS, JavaScript, JSON, images and fonts.`,
      );
    }
    const content = decodeContent(file, path);
    totalBytes += content.length;
    if (totalBytes > PUBLISH_LIMITS.maxTotalBytes) {
      throw new PublishError(
        "PUBLISH_TOO_LARGE",
        "Your files add up to more than 2 MB. Make images smaller, or connect GitHub for a bigger app.",
      );
    }
    const key = path.toLowerCase();
    if (seen.has(key)) throw new PublishError("PUBLISH_DUPLICATE_FILE", `${path} is in the upload twice.`);
    seen.add(key);
    entries.push({ path, content, text: TEXT_EXTENSIONS.has(ext) });
  }
  entries = stripCommonFolder(entries);
  const names = new Set(entries.map((e) => e.path));
  if (!names.has("index.html") && !names.has("package.json")) {
    throw new PublishError(
      "PUBLISH_NO_ENTRY",
      "Utplava needs an index.html (your home page) or a package.json at the top of your files. If your AI tool gave you one page of HTML, paste it and Utplava names it index.html.",
    );
  }
  return { files: entries.sort((a, b) => a.path.localeCompare(b.path)), totalBytes };
}

// ---------- leaked secret keys ----------

const SECRET_PATTERNS = [
  { kind: "a Stripe or Clerk secret key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/ },
  { kind: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "an OpenAI API key", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  { kind: "an OpenAI API key", re: /\bsk-[A-Za-z0-9]{40,}\b/ },
  { kind: "an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "a GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { kind: "a private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/ },
  { kind: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "a Resend API key", re: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}/ },
  { kind: "a SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}/ },
  { kind: "a Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { kind: "a Razorpay key secret", re: /key_secret["'\s]*[:=]\s*["'][A-Za-z0-9]{20,}["']/i },
];

const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;

function isServiceRoleJwt(payloadPart) {
  try {
    const json = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return json?.role === "service_role";
  } catch {
    return false;
  }
}

export function findLeakedSecrets(files) {
  const found = [];
  for (const file of files) {
    if (!file.text) continue;
    const text = file.content.toString("utf8");
    for (const { kind, re } of SECRET_PATTERNS) {
      if (re.test(text)) {
        found.push({ path: file.path, kind });
        break;
      }
    }
    if (found.at(-1)?.path === file.path) continue;
    for (const match of text.matchAll(JWT)) {
      if (isServiceRoleJwt(match[1])) {
        found.push({ path: file.path, kind: "a Supabase service_role key" });
        break;
      }
    }
  }
  return found;
}

// ---------- obvious phishing ----------

const BRANDS = [
  "paypal", "apple id", "icloud", "microsoft", "outlook", "office 365", "gmail", "google account",
  "facebook", "instagram", "whatsapp", "netflix", "amazon", "metamask", "coinbase", "binance",
  "trust wallet", "phantom", "ledger", "sbi", "hdfc", "icici", "axis bank", "kotak", "paytm",
  "phonepe", "bank of america", "chase", "wells fargo", "income tax", "aadhaar",
];
const BRAND_RE = BRANDS.map((b) => b.replace(/ /g, "\\s+")).join("|");
const BRAND_LOGIN = new RegExp(
  `(?:sign\\s*in|log\\s*in|login|verify|confirm|unlock|update)\\s+(?:to\\s+|into\\s+)?(?:your\\s+)?(?:${BRAND_RE})\\b|\\b(?:${BRAND_RE})\\s+(?:login|log\\s*in|sign\\s*in|verification|security\\s+check)`,
  "i",
);
const TITLE_BRAND = new RegExp(`<title[^>]*>[^<]*\\b(?:${BRAND_RE})\\b[^<]*</title>`, "i");
const PASSWORD_INPUT = /type\s*=\s*["']?password/i;
const SEED_PHRASE = /\b(?:seed|recovery|secret|mnemonic)\s+(?:phrase|words)\b|\b(?:12|24)[\s-]word\b/i;
const ANY_INPUT = /<(?:input|textarea)\b/i;
const CARD_FIELDS = /\b(?:cvv|cvc|atm\s+pin|upi\s+pin)\b/i;

export function findPhishingSignals(files) {
  const reasons = [];
  const pages = files.filter((f) => f.text && /\.(?:html?|jsx?|tsx?)$/i.test(f.path));
  for (const file of pages) {
    const text = file.content.toString("utf8");
    const hasInput = ANY_INPUT.test(text) || /\binput\b/.test(text);
    if (PASSWORD_INPUT.test(text) && (BRAND_LOGIN.test(text) || TITLE_BRAND.test(text))) {
      reasons.push({ path: file.path, reason: "a sign-in form that looks like another company's" });
    } else if (SEED_PHRASE.test(text) && hasInput) {
      reasons.push({ path: file.path, reason: "a form asking for a wallet recovery phrase" });
    } else if (CARD_FIELDS.test(text) && hasInput) {
      reasons.push({ path: file.path, reason: "a form asking for card or UPI PIN details directly" });
    }
  }
  return reasons;
}

export function contentDigest(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return hash.digest("hex");
}

// All checks that need no database or network. Throws PublishError.
export function checkPublishUpload(files) {
  const validated = validatePublishFiles(files);
  const secrets = findLeakedSecrets(validated.files);
  if (secrets.length) {
    const first = secrets[0];
    throw new PublishError(
      "PUBLISH_SECRET_FOUND",
      `${first.path} contains ${first.kind}. Anyone could copy it from your live site. Remove it from the file, then add it on your app's page in Utplava, where it stays private.`,
      400,
      { files: secrets.map((s) => s.path).slice(0, 10) },
    );
  }
  const phishing = findPhishingSignals(validated.files);
  if (phishing.length) {
    throw new PublishError(
      "PUBLISH_REVIEW_REQUIRED",
      `${phishing[0].path} has ${phishing[0].reason}, so Utplava held it back. If your app is genuine, email contact@dealup.co.in and we'll review it with you.`,
      422,
    );
  }
  return validated;
}

// ---------- GitHub (Utplava's organisation) ----------

function publisherOctokit(env) {
  const { token } = publisherConfig(env);
  return new Octokit({ auth: token, userAgent: "utplava-publisher" });
}

// Finds Utplava's own GitHub App installation on the publishing
// organisation, stores it, and makes sure it is linked to no workspace.
export async function ensurePublisherInstallation(db, { workspaceId, env = process.env, appOctokitFactory = createAppOctokit }) {
  const { org } = publisherConfig(env);
  const appOctokit = await appOctokitFactory({ env });
  let installation;
  try {
    installation = (await appOctokit.apps.getOrgInstallation({ org })).data;
  } catch {
    throw new PublishError(
      "PUBLISH_NOT_CONFIGURED",
      "Uploading files isn't switched on yet. Email contact@dealup.co.in and we'll put your app online with you.",
      503,
    );
  }
  const saved = await db.query(
    `INSERT INTO github_installations (workspace_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_installation_id)
     DO UPDATE SET account_login = EXCLUDED.account_login, updated_at = now()
     RETURNING id`,
    [workspaceId, installation.id, installation.account?.login ?? org, installation.account?.type ?? "Organization"],
  );
  const id = saved.rows[0].id;
  await db.query(`DELETE FROM workspace_github_installations WHERE github_installation_id = $1`, [id]);
  return { id, org };
}

async function createManagedRepository(octokit, { org, name }) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const repoName = `${slugForName(name).slice(0, 60)}-${suffix}`;
  const created = await octokit.repos.createInOrg({
    org,
    name: repoName,
    private: true,
    auto_init: true,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
    description: "Uploaded to Utplava",
  });
  return created.data;
}

async function commitFiles(octokit, { owner, repo, branch, files, message }) {
  const head = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const parent = head.data.object.sha;
  const tree = [];
  for (const file of files) {
    const blob = await octokit.git.createBlob({
      owner,
      repo,
      content: file.content.toString("base64"),
      encoding: "base64",
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.data.sha });
  }
  // No base_tree: the upload REPLACES the app's files, so a file the person
  // removed is removed from the live site too.
  const newTree = await octokit.git.createTree({ owner, repo, tree });
  const author = { name: "Utplava", email: "publish@utplava.dev" };
  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.data.sha,
    parents: [parent],
    author,
    committer: author,
  });
  await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false });
  return commit.data.sha;
}

async function loadManagedApp(db, { workspaceId, appId }) {
  const result = await db.query(
    `SELECT a.id AS app_id, a.name, r.id AS repository_id, r.full_name, r.default_branch
       FROM apps a
       JOIN github_repositories r ON r.id = a.repository_id
      WHERE a.id = $1 AND a.workspace_id = $2 AND a.deleted_at IS NULL
        AND r.workspace_id = $2 AND r.managed_by_utplava`,
    [appId, workspaceId],
  );
  if (!result.rows[0]) {
    throw new PublishError(
      "PUBLISH_APP_NOT_FOUND",
      "That app wasn't uploaded to Utplava, so it can't be updated with files. Apps from GitHub update when you push to GitHub.",
      404,
    );
  }
  return result.rows[0];
}

async function assertNameFree(db, { workspaceId, name }) {
  const taken = await db.query(
    `SELECT 1 FROM apps WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
    [workspaceId, slugForName(name)],
  );
  if (taken.rowCount) {
    throw new PublishError(
      "PUBLISH_NAME_TAKEN",
      `You already have an app called "${name}". Pick that app to update it, or choose another name.`,
      409,
    );
  }
}

async function enforceGlobalLimit(db) {
  const result = await db.query(
    `SELECT count(*)::int AS count FROM direct_publishes WHERE created_at > now() - interval '1 hour'`,
  );
  if (result.rows[0].count >= PUBLISH_LIMITS.globalPerHour) {
    throw new PublishError(
      "PUBLISH_BUSY",
      "Utplava is taking a lot of uploads right now. Please try again in a few minutes.",
      429,
    );
  }
}

// Stores the files and returns the repository to analyse and deploy.
// New app: pass name. Update: pass appId (must be an uploaded app).
export async function publishFiles(
  db,
  {
    customerId,
    workspaceId,
    name,
    appId = null,
    files,
    source = "dashboard",
    env = process.env,
    octokitFactory = publisherOctokit,
    installationFinder = ensurePublisherInstallation,
  },
) {
  await getAuthorizedWorkspace(db, { customerId, workspaceId });
  const upload = checkPublishUpload(files);
  publisherConfig(env);

  let target = null;
  let appName;
  if (appId) {
    target = await loadManagedApp(db, { workspaceId, appId });
    appName = target.name;
  } else {
    appName = validateAppName(name);
    await assertNameFree(db, { workspaceId, name: appName });
    await enforceActiveAppLimit(db, { workspaceId });
  }

  await enforceRateLimit(db, { workspaceId, action: "direct_publish_hour", limit: PUBLISH_LIMITS.perHour, windowSeconds: 3600 });
  await enforceRateLimit(db, { workspaceId, action: "direct_publish_day", limit: PUBLISH_LIMITS.perDay, windowSeconds: 86400 });
  await enforceGlobalLimit(db);

  const octokit = octokitFactory(env);
  let repositoryId;
  let owner;
  let repo;
  let branch;
  if (target) {
    repositoryId = target.repository_id;
    [owner, repo] = target.full_name.split("/");
    branch = target.default_branch || "main";
  } else {
    const installation = await installationFinder(db, { workspaceId, env });
    const created = await createManagedRepository(octokit, { org: installation.org, name: appName });
    owner = created.owner?.login ?? installation.org;
    repo = created.name;
    branch = created.default_branch || "main";
    const saved = await db.query(
      `INSERT INTO github_repositories
         (workspace_id, github_installation_id, github_repository_id, full_name, default_branch, private, managed_by_utplava, display_name)
       VALUES ($1, $2, $3, $4, $5, true, true, $6)
       RETURNING id`,
      [workspaceId, installation.id, created.id, created.full_name, branch, appName],
    );
    repositoryId = saved.rows[0].id;
  }

  const commitSha = await commitFiles(octokit, {
    owner,
    repo,
    branch,
    files: upload.files,
    message: `Upload ${upload.files.length} file${upload.files.length === 1 ? "" : "s"} from ${source === "mcp" ? "an AI chat" : "the dashboard"}`,
  });

  await db.query(
    `INSERT INTO direct_publishes
       (workspace_id, repository_id, customer_identity_id, source, file_count, total_bytes, content_sha256, commit_sha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [workspaceId, repositoryId, customerId, source === "mcp" ? "mcp" : "dashboard", upload.files.length, upload.totalBytes, contentDigest(upload.files), commitSha],
  );

  return { repositoryId, appName, fileCount: upload.files.length, totalBytes: upload.totalBytes, commitSha };
}

export function safePublishError(error) {
  if (error instanceof PublishError || error?.name === "PublishError") {
    return { error: { code: error.code, message: error.message } };
  }
  if (error?.code === "WORKSPACE_RATE_LIMIT_REACHED") {
    return { error: { code: error.code, message: "You've uploaded a lot in a short time. Please wait a while and try again." } };
  }
  if (error?.code === "WORKSPACE_APP_LIMIT_REACHED") {
    return { error: { code: error.code, message: "The free plan includes up to 3 apps. Need more? Email contact@dealup.co.in." } };
  }
  if (error?.code === "WORKSPACE_NOT_FOUND" || error?.status === 404) {
    return { error: { code: "NOT_FOUND", message: "That workspace or app wasn't found." } };
  }
  return { error: { code: "PUBLISH_FAILED", message: "Something went wrong while uploading. Please try again. If it keeps happening, email contact@dealup.co.in." } };
}
