"use client";

import { useEffect, useState } from "react";
import { DRAFT_PAGE, DRAFT_REPO, forgetDraft, readDraft } from "./try-draft.js";

// After sign-in (2026-11-09): picks up what the person did on the sign-in
// page. A pasted page is published only after one explicit click, never
// silently (a shared computer must not publish a stranger's page). Anything
// older than a day is dropped (try-draft.js).
export function PendingPublish({ workspaceId }) {
  const [page, setPage] = useState(null);
  const [repo, setRepo] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const p = readDraft(DRAFT_PAGE);
    if (p?.html && p?.name) {
      setPage(p);
      setName(p.name);
    }
    const r = readDraft(DRAFT_REPO);
    if (r?.fullName) setRepo(r);
  }, []);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), files: [{ path: "index.html", content: page.html }] }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.appId) {
        setError(body?.error?.message || "Something went wrong while uploading. Please try again.");
        setBusy(false);
        return;
      }
      forgetDraft(DRAFT_PAGE);
      try {
        fetch("/api/try/event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "try_published" }), keepalive: true }).catch(() => {});
      } catch {
        // counting never matters
      }
      window.location.assign(`/apps/${encodeURIComponent(body.appId)}?workspace=${encodeURIComponent(workspaceId)}`);
    } catch {
      setError("The upload didn't go through. Check your connection and try again.");
      setBusy(false);
    }
  }

  if (page) {
    return (
      <section className="card pending-publish">
        <h2>Your page is ready to go online</h2>
        <p className="card-sub">The page you previewed before signing in. Confirm its name and put it online.</p>
        <div className="try-name-row">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="App name" />
          <button type="button" className="button primary" onClick={publish} disabled={busy}>
            {busy ? "Putting it online…" : "Put it online"}
          </button>
          <button type="button" className="button" onClick={() => { forgetDraft(DRAFT_PAGE); setPage(null); }} disabled={busy}>
            Discard
          </button>
        </div>
        {error ? <p className="try-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  if (repo) {
    return (
      <section className="card pending-publish">
        <h2>Ready for {repo.fullName}</h2>
        <p className="card-sub">
          You checked it before signing in. Open <a href={`/new?workspace=${encodeURIComponent(workspaceId)}`}>New app</a>, connect GitHub if asked, and pick {repo.fullName} from your list.
        </p>
        <button type="button" className="try-link" onClick={() => { forgetDraft(DRAFT_REPO); setRepo(null); }}>Dismiss</button>
      </section>
    );
  }

  return null;
}
