"use client";

import { useState } from "react";

// Per-app switch for push-to-deploy. On by default for every app.
// labelMode "name" shows "Deploy on push"; "state" shows On / Off (used
// where the setting is already named next to it, e.g. the app page).
export function AutoDeployToggle({ workspaceId, appId, initialEnabled, labelMode = "name" }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  async function toggle() {
    const next = !enabled;
    setSaving(true);
    setError(false);
    setEnabled(next);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/auto-deploy`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) },
      );
      if (!response.ok) throw new Error("request_failed");
    } catch {
      setEnabled(!next);
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`auto-deploy-toggle${enabled ? " on" : ""}`}
      onClick={toggle}
      disabled={saving}
      title={enabled ? "Pushing to the main branch redeploys this app" : "Pushes to GitHub won't redeploy this app"}
    >
      <span className="auto-deploy-track" aria-hidden="true"><span className="auto-deploy-thumb" /></span>
      <span>{error ? "Couldn't save" : labelMode === "state" ? (enabled ? "On" : "Off") : "Deploy on push"}</span>
    </button>
  );
}
