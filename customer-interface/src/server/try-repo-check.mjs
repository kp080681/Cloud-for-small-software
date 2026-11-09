// Try before sign-in (2026-11-09): a signed-out visitor pastes a GitHub
// repository link and sees whether Utplava can run it, before being asked
// to sign in.
//
// Safety: only PUBLIC repositories are read, through GitHub's API, and only
// the top-level file list, package.json and .env.example. Nothing is
// cloned, built or run. Only setting NAMES are shown, never values. This is
// the one server action a signed-out visitor can cause, so it is
// rate-limited per visitor (hashed IP) and overall, and nothing about the
// visitor or the repository is stored.

import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";
import { detectProject } from "../shared/control-plane/project-detection.mjs";
import { serviceGuideFor } from "../shared/service-guides.mjs";

export const TRY_LIMITS = Object.freeze({ perVisitorPerHour: 12, overallPerHour: 400 });

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export class TryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "TryError";
    this.code = code;
    this.status = status;
  }
}

// Accepts "owner/repo", "github.com/owner/repo", full https links, ".git"
// endings and links into a branch or file. Returns { owner, repo } or null.
export function parseRepoInput(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text || text.length > 300) return null;
  text = text.replace(/^git@github\.com:/i, "github.com/");
  text = text.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (/^github\.com\//i.test(text)) text = text.slice("github.com/".length);
  else if (text.includes(".") && text.split("/")[0].includes(".")) return null; // another site
  const [owner, repoPart] = text.split(/[/?#]/).filter(Boolean);
  if (!owner || !repoPart) return null;
  const repo = repoPart.replace(/\.git$/i, "");
  if (!NAME.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

export function visitorBucket(ip, secret = process.env.UTPLAVA_SESSION_SECRET || "utplava-try") {
  const hash = crypto.createHmac("sha256", secret).update(String(ip || "unknown")).digest("hex").slice(0, 32);
  return `try:${hash}`;
}

async function bump(db, bucket, limit) {
  const result = await db.query(
    `INSERT INTO public_rate_limits (bucket, window_start, hits)
     VALUES ($1, date_trunc('hour', now()), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = public_rate_limits.hits + 1
     RETURNING hits`,
    [bucket],
  );
  return result.rows[0].hits <= limit;
}

// Cheap counters from the sign-in page (preview shown, publish clicked):
// their own, more generous limit so they can't be used to flood the table.
export async function allowTryEvent(db, { ip }) {
  return bump(db, `ev:${visitorBucket(ip)}`, 60);
}

export async function enforceTryLimits(db, { ip }) {
  if (!(await bump(db, visitorBucket(ip), TRY_LIMITS.perVisitorPerHour))) {
    throw new TryError("TRY_LIMIT", "That's a lot of checks in a short time. Sign in to keep going, or try again in an hour.", 429);
  }
  if (!(await bump(db, "try:all", TRY_LIMITS.overallPerHour))) {
    throw new TryError("TRY_BUSY", "Lots of people are checking apps right now. Sign in and pick your app instead.", 429);
  }
  // Housekeeping: old windows are useless.
  await db.query(`DELETE FROM public_rate_limits WHERE window_start < now() - interval '2 days'`).catch(() => {});
}

function frameworkLabel(detection, deps) {
  if (detection.plainHtml) return "a plain website (HTML)";
  if (detection.framework === "nextjs") return "a Next.js app";
  const react = Boolean(deps.react);
  if (deps.vite) return react ? "a React app (Vite)" : "a Vite app";
  if (react) return "a React app";
  if (detection.runtime === "nodejs") return "a Node.js app";
  return "a website with a build step";
}

const UNSUPPORTED_MESSAGES = {
  PACKAGE_JSON_NOT_FOUND: "Utplava couldn't find an index.html or a package.json at the top of this repository, so it can't tell how to run it.",
  UNSUPPORTED_PROJECT: "This doesn't look like a web app Utplava can run yet (it supports websites, React, Vite and Next.js apps).",
  BUILD_SCRIPT_MISSING: "This app has no build step in its package.json. Ask your AI tool to add one, and Utplava can put it online.",
};

export function settingNamesFromEnvExample(text) {
  const names = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,63})\s*=/.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
    if (names.length >= 25) break;
  }
  return names;
}

function decode(content) {
  return Buffer.from(content || "", "base64").toString("utf8");
}

export function summarize({ fullName, rootFiles, packageJson, envExample }) {
  const detection = detectProject({ packageJson, rootFiles });
  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  if (!detection.supported) {
    return {
      status: "unsupported",
      fullName,
      message: UNSUPPORTED_MESSAGES[detection.reason] || UNSUPPORTED_MESSAGES.UNSUPPORTED_PROJECT,
    };
  }
  const settings = settingNamesFromEnvExample(envExample).map((name) => {
    const guide = serviceGuideFor(name);
    return { name, service: guide?.serviceName ?? null };
  });
  return {
    status: "ready",
    fullName,
    kind: frameworkLabel(detection, deps),
    lovable: Boolean(deps["lovable-tagger"]),
    database: detection.databaseRequired ? "Needs a database: Utplava sets one up for you." : null,
    supabase: Boolean(deps["@supabase/supabase-js"]),
    settings,
  };
}

function githubClient(env) {
  const token = env.UTPLAVA_PUBLISH_GITHUB_TOKEN;
  return new Octokit({ auth: token || undefined, userAgent: "utplava-try" });
}

export async function checkPublicRepository({ owner, repo }, { env = process.env, octokitFactory = githubClient } = {}) {
  const gh = octokitFactory(env);
  const fullName = `${owner}/${repo}`;
  let meta;
  try {
    meta = (await gh.repos.get({ owner, repo })).data;
  } catch (error) {
    if (error?.status === 404 || error?.status === 403 || error?.status === 451) {
      return { status: "private", fullName };
    }
    throw error;
  }
  if (meta.private) return { status: "private", fullName };
  const ref = meta.default_branch;
  let root = [];
  try {
    const listing = (await gh.repos.getContent({ owner, repo, path: "", ref })).data;
    root = Array.isArray(listing) ? listing : [];
  } catch (error) {
    if (error?.status === 404) return { status: "unsupported", fullName: meta.full_name, message: "This repository is empty." };
    throw error;
  }
  const rootFiles = root.filter((e) => e.type === "file").map((e) => e.name);
  const read = async (name) => {
    const entry = root.find((e) => e.type === "file" && e.name === name);
    if (!entry || entry.size > 200_000) return null;
    const file = (await gh.repos.getContent({ owner, repo, path: name, ref })).data;
    return decode(file?.content);
  };
  let packageJson = null;
  const pkgText = await read("package.json");
  if (pkgText) {
    try {
      packageJson = JSON.parse(pkgText);
    } catch {
      return { status: "unsupported", fullName: meta.full_name, message: "This repository's package.json couldn't be read. Ask your AI tool to fix it." };
    }
  }
  const envExample = (await read(".env.example")) ?? (await read(".env.sample"));
  return summarize({ fullName: meta.full_name, rootFiles, packageJson, envExample });
}
