"use client";

import { useState } from "react";
import { DRAFT_PAGE, DRAFT_REPO, saveDraft } from "./try-draft.js";

// Try before sign-in (2026-11-09). Two ways in, both before any sign-in:
//  - Paste a page: shown right here in a sealed-off frame (sandboxed, no
//    same-origin, no forms, no navigation of this page), so nothing goes
//    online and nothing can reach Utplava's cookies. "Put it online" keeps
//    the page in this browser during sign-in; after sign-in the person
//    confirms once and it is published (pending-publish.js).
//  - Check a GitHub repository: public repositories are checked on the
//    server (read only, rate-limited); private ones are explained.

const MAX_BYTES = 2 * 1024 * 1024;

function slugFor(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "your-page";
}

function count(step) {
  try {
    fetch("/api/try/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step }), keepalive: true }).catch(() => {});
  } catch {
    // counting never matters to the visitor
  }
}

function SignInButtons({ googleEnabled, githubOnly = false, note }) {
  return (
    <div className="try-signin">
      {note ? <p className="try-signin-note">{note}</p> : null}
      <div className="try-signin-buttons">
        {googleEnabled && !githubOnly ? (
          <a className="button primary" href="/api/auth/google/start">Continue with Google</a>
        ) : null}
        <a className={googleEnabled && !githubOnly ? "button" : "button primary"} href="/api/auth/github/start">Continue with GitHub</a>
      </div>
      <small>Free for up to 3 apps. No card needed. Utplava never sees your password.</small>
    </div>
  );
}

function PastePanel({ googleEnabled }) {
  const [html, setHtml] = useState("");
  const [preview, setPreview] = useState(null);
  const [name, setName] = useState("");
  const [stage, setStage] = useState("paste"); // paste | preview | signin
  const [error, setError] = useState(null);

  function showPreview() {
    setError(null);
    if (!html.trim()) return setError("Paste the code your AI tool gave you first.");
    if (!/<html|<body|<div|<!doctype|<h1|<main|<section/i.test(html)) {
      return setError("That doesn't look like a web page. Paste the whole code block, usually starting with <!DOCTYPE html>.");
    }
    if (new Blob([html]).size > MAX_BYTES) return setError("That page is over 2 MB. Sign in and upload it as files instead.");
    setPreview(html);
    setStage("preview");
    count("try_previewed");
  }

  function putOnline(event) {
    event.preventDefault();
    setError(null);
    const clean = name.trim().replace(/\s+/g, " ");
    if (clean.length < 2 || clean.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(clean)) {
      return setError("Give it a name of 2 to 40 letters or numbers, like \"Bakery site\".");
    }
    if (!saveDraft(DRAFT_PAGE, { name: clean, html: preview })) {
      return setError("Your browser couldn't hold the page during sign-in. Sign in first, then paste it on the New app page.");
    }
    count("try_publish_clicked");
    setStage("signin");
  }

  if (stage === "paste") {
    return (
      <div className="try-panel">
        <label className="try-label" htmlFor="try-html">Paste the page ChatGPT or Claude made for you</label>
        <textarea
          id="try-html"
          className="try-textarea"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={"<!DOCTYPE html>\n<html>\n  ..."}
        />
        {error ? <p className="try-error" role="alert">{error}</p> : null}
        <div className="try-actions">
          <button type="button" className="button primary" onClick={showPreview}>See it as a website</button>
          <small>Nothing goes online yet. The preview stays in your browser.</small>
        </div>
      </div>
    );
  }

  const slug = slugFor(name);
  return (
    <div className="try-panel">
      <div className="try-browser" aria-label="Preview of your page">
        <div className="try-browser-bar">
          <span className="try-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="try-url">{slug}.utplava.dev</span>
        </div>
        <iframe
          className="try-frame"
          title="Preview of your page"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={preview}
        />
      </div>

      {stage === "preview" ? (
        <form className="try-name" onSubmit={putOnline}>
          <label className="try-label" htmlFor="try-name">Like it? Give it a name and put it online</label>
          <div className="try-name-row">
            <input id="try-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Bakery site" autoComplete="off" />
            <button type="submit" className="button primary">Put it online</button>
          </div>
          {error ? <p className="try-error" role="alert">{error}</p> : null}
          <button type="button" className="try-link" onClick={() => setStage("paste")}>Edit the code</button>
        </form>
      ) : (
        <SignInButtons
          googleEnabled={googleEnabled}
          note={`Last step: sign in, and ${slug}.utplava.dev goes live. Your page is kept in this browser while you sign in.`}
        />
      )}
    </div>
  );
}

function RepoPanel({ googleEnabled }) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function check(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!repo.trim()) return setError("Paste your repository link, like github.com/your-name/your-app.");
    setBusy(true);
    try {
      const response = await fetch("/api/try/repo-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repo.trim() }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) setError(body?.error?.message || "Utplava couldn't check that repository just now.");
      else {
        setResult(body);
        if (body?.fullName && body.status !== "unsupported") saveDraft(DRAFT_REPO, { fullName: body.fullName });
      }
    } catch {
      setError("The check didn't go through. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <div className="try-panel">
      <form onSubmit={check}>
        <label className="try-label" htmlFor="try-repo">Your app's GitHub link (Lovable, Bolt, Cursor…)</label>
        <div className="try-name-row">
          <input id="try-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="github.com/your-name/your-app" autoComplete="off" spellCheck={false} />
          <button type="submit" className="button primary" disabled={busy}>{busy ? "Checking…" : "Check it"}</button>
        </div>
      </form>
      {error ? <p className="try-error" role="alert">{error}</p> : null}

      {result?.status === "ready" ? (
        <div className="try-result ok">
          <strong>{result.fullName}</strong>
          <ul>
            <li>It's {result.kind}{result.lovable ? ", made with Lovable" : ""}. Utplava can put it online.</li>
            {result.database ? <li>{result.database}</li> : null}
            {result.supabase ? <li>Uses Supabase: your Supabase project stays yours, and its keys are added after sign-in.</li> : null}
            {result.settings?.length ? (
              <li>
                Needs {result.settings.length} setting{result.settings.length === 1 ? "" : "s"}, added after sign-in:{" "}
                {result.settings.slice(0, 6).map((s) => s.service ? `${s.name} (${s.service})` : s.name).join(", ")}
                {result.settings.length > 6 ? "…" : ""}
              </li>
            ) : null}
          </ul>
          <SignInButtons googleEnabled={googleEnabled} githubOnly note="Sign in with GitHub, then pick this repository. The check is already done." />
        </div>
      ) : null}

      {result?.status === "private" ? (
        <div className="try-result">
          <strong>{result.fullName}</strong>
          <p>This repository is private, or the link isn't quite right. Private is good: your code stays yours. Sign in with GitHub and pick it from your list. It takes a minute.</p>
          <SignInButtons googleEnabled={googleEnabled} githubOnly />
        </div>
      ) : null}

      {result?.status === "unsupported" ? (
        <div className="try-result warn">
          <strong>{result.fullName}</strong>
          <p>{result.message}</p>
          <p>Stuck? Email <a href="mailto:contact@dealup.co.in">contact@dealup.co.in</a> with the link and a real person will look.</p>
        </div>
      ) : null}
    </div>
  );
}

export function TryIt({ googleEnabled }) {
  const [tab, setTab] = useState("paste");
  return (
    <section className="card try-it">
      <div className="try-tabs" role="tablist" aria-label="How is your app made?">
        <button type="button" role="tab" aria-selected={tab === "paste"} className={tab === "paste" ? "try-tab on" : "try-tab"} onClick={() => setTab("paste")}>
          Paste a page
        </button>
        <button type="button" role="tab" aria-selected={tab === "repo"} className={tab === "repo" ? "try-tab on" : "try-tab"} onClick={() => setTab("repo")}>
          My app is on GitHub
        </button>
      </div>
      {tab === "paste" ? <PastePanel googleEnabled={googleEnabled} /> : <RepoPanel googleEnabled={googleEnabled} />}
    </section>
  );
}
