"use client";

import { useEffect, useState } from "react";

// Lists the AI tools/clients (Claude Code, etc.) that currently hold an MCP
// grant for this workspace, with a way to revoke one. The backend
// (listTokenFamilies / revokeTokenFamily in src/server/mcp-auth.mjs, and
// their routes under /api/workspaces/[workspaceId]/mcp/) already existed;
// this is the first UI for it — before this, a grant was revocable only by
// calling the API directly.
function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

export function McpGrantsPanel({ workspaceId }) {
  const [state, setState] = useState({ loading: true, error: null, grants: null });
  const [revokingId, setRevokingId] = useState(null);

  async function load() {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/grants`);
      if (!response.ok) throw new Error("Connected apps could not be loaded.");
      const body = await response.json();
      setState({ loading: false, error: null, grants: body.grants });
    } catch (error) {
      setState({ loading: false, error: error.message || "Connected apps could not be loaded.", grants: null });
    }
  }

  useEffect(() => {
    load();
    // Reload when the workspace changes rather than keeping a stale list
    // from whichever workspace was selected before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function revoke(tokenFamilyId) {
    setRevokingId(tokenFamilyId);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/mcp/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenFamilyId }),
      });
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setState((previous) => ({ ...previous, error: "That connection could not be removed. Try again." }));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section className="panel section-gap" id="mcp-connections">
      <div className="row">
        <div>
          <h2>Connected apps</h2>
          <small>AI tools authorized to manage this workspace on your behalf</small>
        </div>
      </div>

      {state.loading ? <p className="muted fine">Loading…</p> : null}
      {state.error ? <p className="helptext">{state.error}</p> : null}

      {!state.loading && state.grants && state.grants.length === 0 ? (
        <p className="muted fine">No AI tools are connected to this workspace yet.</p>
      ) : null}

      {state.grants && state.grants.length > 0 ? (
        <div className="application-list">
          {state.grants.map((grant) => (
            <div className="repo" key={grant.tokenFamilyId}>
              <span className="repo-left">
                <span className="repo-icon">{(grant.clientName || "?").slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{grant.clientName || "Unknown client"}</strong>
                  <small>Authorized {formatDate(grant.authorizedAt)}</small>
                  <small>{grant.revoked ? "Access removed" : `Last used ${formatDate(grant.lastRefreshedAt)}`}</small>
                </span>
              </span>
              {grant.revoked ? (
                <span className="status neutral">
                  <span className="dot" aria-hidden="true" />
                  Removed
                </span>
              ) : (
                <button
                  className="button"
                  onClick={() => revoke(grant.tokenFamilyId)}
                  disabled={revokingId === grant.tokenFamilyId}
                >
                  {revokingId === grant.tokenFamilyId ? "Removing…" : "Remove access"}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
