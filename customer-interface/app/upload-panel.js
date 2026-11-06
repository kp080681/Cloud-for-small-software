"use client";

import { useRef, useState } from "react";

// Direct publishing (2026-11-06): put an app online without GitHub. Two
// ways in: paste one page of HTML (what ChatGPT or Claude usually hands
// over), or choose the app's files or folder. The server re-checks
// everything (direct-publish.mjs); the checks here only give a faster,
// friendlier answer before uploading.

const MAX_FILES = 50;
const MAX_BYTES = 2 * 1024 * 1024;
const TEXT = /\.(html?|css|m?js|cjs|jsx|tsx?|json|txt|md|xml|svg|map|webmanifest|csv)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;
const SKIP = /(^|\/)(node_modules|\.git|\.next|\.vercel|\.DS_Store)(\/|$)/;

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function relativePath(file) {
  return (file.webkitRelativePath || file.name).replace(/\\/g, "/");
}

export function UploadPanel({ workspaceId, appId = null, appName = null }) {
  const [method, setMethod] = useState("paste");
  const [name, setName] = useState("");
  const [html, setHtml] = useState("");
  const [files, setFiles] = useState([]);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const updating = Boolean(appId);

  function takeFiles(list) {
    setError(null);
    const kept = [];
    let left = 0;
    for (const file of Array.from(list || [])) {
      const path = relativePath(file);
      if (SKIP.test(path) || path.split("/").some((p) => p.startsWith(".") && !/^\.env/i.test(p))) {
        left += 1;
        continue;
      }
      kept.push(file);
    }
    setFiles(kept);
    setSkipped(left);
  }

  const totalBytes = method === "paste" ? new Blob([html]).size : files.reduce((sum, f) => sum + f.size, 0);

  function precheck() {
    if (!updating && name.trim().length < 2) return "Give your app a name, like \"Bakery site\".";
    if (method === "paste") {
      if (!html.trim()) return "Paste your app's HTML first.";
      if (!/<html|<body|<div|<!doctype/i.test(html)) return "That doesn't look like HTML. Paste the whole page your AI tool gave you, starting with <!DOCTYPE html> or <html>.";
      return null;
    }
    if (!files.length) return "Choose your app's files or folder first.";
    if (files.length > MAX_FILES) return `That's ${files.length} files. Uploads can have up to ${MAX_FILES}. For a bigger app, connect GitHub instead.`;
    if (totalBytes > MAX_BYTES) return "Your files add up to more than 2 MB. Make images smaller, or connect GitHub for a bigger app.";
    const envFile = files.find((f) => /(^|\/)\.env/i.test(relativePath(f)));
    if (envFile) return "Leave out .env files: they hold your private keys. Add those keys on your app's page after it's uploaded.";
    const odd = files.find((f) => !TEXT.test(f.name) && !BINARY.test(f.name));
    if (odd) return `${relativePath(odd)} isn't a file type Utplava can put online. Upload web files: HTML, CSS, JavaScript, JSON, images and fonts.`;
    return null;
  }

  async function submit(event) {
    event.preventDefault();
    const problem = precheck();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let payloadFiles;
      if (method === "paste") {
        payloadFiles = [{ path: "index.html", content: html }];
      } else {
        payloadFiles = await Promise.all(
          files.map(async (file) =>
            BINARY.test(file.name)
              ? { path: relativePath(file), content: base64FromBuffer(await file.arrayBuffer()), encoding: "base64" }
              : { path: relativePath(file), content: await file.text() },
          ),
        );
      }
      // Never leave the person staring at "Uploading…": give up after 70s
      // (the server stops at 60s) and say what to do.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 70_000);
      let response;
      try {
        response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(updating ? { appId, files: payloadFiles } : { name: name.trim(), files: payloadFiles }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.appId) {
        setError(body?.error?.message || "Something went wrong while uploading. Please try again.");
        setBusy(false);
        return;
      }
      // A full page load, not a client-side route change: the app page is
      // new, and this guarantees the person lands on it.
      window.location.assign(`/apps/${encodeURIComponent(body.appId)}?workspace=${encodeURIComponent(workspaceId)}`);
    } catch (error) {
      setError(
        error?.name === "AbortError"
          ? "This is taking longer than it should. Open Apps to see if your app was added; if not, try again."
          : "The upload didn't go through. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form className="card upload-panel" onSubmit={submit}>
      <h2>{updating ? `Upload a new version of ${appName ?? "this app"}` : "Upload your app"}</h2>
      <p className="card-sub">
        {updating
          ? "The new files replace the old ones, and your link stays the same."
          : "No GitHub needed. Paste the page your AI tool wrote, or choose your app's files."}
      </p>

      {!updating && (
        <label className="upload-field">
          <span>App name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="Bakery site"
            autoComplete="off"
          />
          <small>Your link uses this name when it's free, like bakery-site.utplava.dev.</small>
        </label>
      )}

      <div className="upload-methods" role="radiogroup" aria-label="How to add your app">
        <button
          type="button"
          role="radio"
          aria-checked={method === "paste"}
          className={method === "paste" ? "upload-method on" : "upload-method"}
          onClick={() => { setMethod("paste"); setError(null); }}
        >
          <strong>Paste HTML</strong>
          <span>One page from ChatGPT or Claude</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={method === "files"}
          className={method === "files" ? "upload-method on" : "upload-method"}
          onClick={() => { setMethod("files"); setError(null); }}
        >
          <strong>Choose files</strong>
          <span>A folder with index.html, or a small Vite or React project</span>
        </button>
      </div>

      {method === "paste" ? (
        <label className="upload-field">
          <span>Your HTML</span>
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={"<!DOCTYPE html>\n<html>\n  ..."}
          />
          <small>In your AI chat, copy the whole code block (it usually starts with &lt;!DOCTYPE html&gt;) and paste it here.</small>
        </label>
      ) : (
        <div
          className="upload-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); takeFiles(e.dataTransfer.files); }}
        >
          <p>Drop your files here, or</p>
          <div className="upload-pick">
            <button type="button" className="button" onClick={() => folderInput.current?.click()}>Choose a folder</button>
            <button type="button" className="button" onClick={() => fileInput.current?.click()}>Choose files</button>
          </div>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => takeFiles(e.target.files)} />
          <input ref={folderInput} type="file" multiple hidden webkitdirectory="" directory="" onChange={(e) => takeFiles(e.target.files)} />
          {files.length > 0 && (
            <p className="upload-summary">
              {files.length} file{files.length === 1 ? "" : "s"}, {sizeLabel(totalBytes)}
              {skipped > 0 ? `. Left out ${skipped} hidden or node_modules file${skipped === 1 ? "" : "s"}.` : "."}
            </p>
          )}
          <small>Up to {MAX_FILES} files and 2 MB. Leave out node_modules and .env files.</small>
        </div>
      )}

      {error && <p className="upload-error" role="alert">{error}</p>}

      <div className="upload-actions">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? (updating ? "Uploading and redeploying…" : "Uploading and starting your app…") : updating ? "Upload new version" : "Put it online"}
        </button>
        <small>Utplava checks your files for private keys and stops them going live by mistake.</small>
      </div>
    </form>
  );
}
