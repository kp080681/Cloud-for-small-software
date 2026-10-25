"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const MESSAGES = {
  DEPLOYMENT_IN_PROGRESS: "Another deployment is running. Try again when it finishes.",
  ROLLBACK_ALREADY_SERVING: "That version is already the one serving.",
  ROLLBACK_TARGET_NOT_FOUND: "That version can't be restored.",
  APP_PAUSED: "This app is paused after repeated failures.",
};

// Two taps on purpose: "Restore" asks once, so a stray tap never swaps
// the live version.
export function RestoreButton({ workspaceId, appId, deploymentId, label }) {
  const router = useRouter();
  const [stage, setStage] = useState("idle");
  const [error, setError] = useState("");

  async function restore() {
    setStage("working");
    setError("");
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/rollback`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deploymentId }) },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(MESSAGES[body.error] || "Couldn't restore this version. Try again in a moment.");
      setStage("done");
      router.refresh();
    } catch (err) {
      setError(err.message);
      setStage("idle");
    }
  }

  if (stage === "done") return <span className="restore-note">Restoring…</span>;
  return (
    <span className="restore">
      {stage === "confirm" ? (
        <>
          <button type="button" className="plain restore-yes" onClick={restore}>Restore {label}?</button>
          <button type="button" className="plain" onClick={() => setStage("idle")}>Cancel</button>
        </>
      ) : (
        <button type="button" className="plain" onClick={() => setStage("confirm")} disabled={stage === "working"}>
          {stage === "working" ? "Restoring…" : "Restore"}
        </button>
      )}
      {error ? <small className="restore-error" role="status">{error}</small> : null}
    </span>
  );
}
