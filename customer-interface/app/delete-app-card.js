"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const MESSAGES = {
  DELETE_CONFIRMATION_MISMATCH: "That doesn't match the app's name exactly.",
  DEPLOYMENT_IN_PROGRESS: "A deployment is running right now. Wait for it to finish, then delete.",
  APP_NOT_FOUND: "This app no longer exists in this workspace.",
};

export function DeleteAppCard({ workspaceId, appId, appName, homeHref }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const matches = typed.trim() === appName;

  async function remove(event) {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/delete`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmName: typed }) },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(MESSAGES[body.error] || "Couldn't start deleting this app. Try again in a moment.");
      router.push(homeHref);
      router.refresh();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="card danger-card">
      <h2>Delete app</h2>
      <p className="card-sub">
        Takes <strong>{appName}</strong> offline and removes its hosting, database and saved settings. Its deployment
        history stays in your records. This can&apos;t be undone.
      </p>
      <form className="inline-form" onSubmit={remove}>
        <input
          aria-label={`Type ${appName} to confirm`}
          placeholder={`Type ${appName} to confirm`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="danger" disabled={!matches || busy}>
          {busy ? "Deleting…" : "Delete app"}
        </button>
      </form>
      {error ? <p className="helptext" role="status">{error}</p> : null}
    </section>
  );
}
