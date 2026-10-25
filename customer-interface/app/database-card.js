"use client";

import { useState } from "react";

const MESSAGES = {
  APP_DATABASE_NOT_READY: "The database is still being set up. Try again in a minute.",
  APP_DATABASE_SECRET_UNAVAILABLE: "Couldn't read the connection details right now. Try again, or email contact@dealup.co.in.",
};

export function DatabaseCard({ workspaceId, appId, ready }) {
  const [connection, setConnection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  async function reveal() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/database`,
        { method: "POST" },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(MESSAGES[body.error] || "Couldn't show the connection details. Try again in a moment.");
      setConnection(body.connectionString);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 1800);
    } catch {
      // Clipboard unavailable: the text is selectable on screen.
    }
  }

  const backupCommand = connection ? `pg_dump --no-owner --no-privileges --file backup.sql "${connection}"` : "";

  return (
    <section className="card">
      <h2>Database</h2>
      <p className="card-sub">
        Your app&apos;s database is standard PostgreSQL. You own the data: back it up or move it to any PostgreSQL host
        whenever you like.
      </p>
      {!connection ? (
        <div className="inline-form">
          <button type="button" onClick={reveal} disabled={busy || !ready}>
            {busy ? "Getting details…" : "Show connection details"}
          </button>
          {!ready ? <small className="muted">Available once the database is ready.</small> : null}
        </div>
      ) : (
        <div className="db-export">
          <label className="db-label" htmlFor="db-connection">Connection string</label>
          <div className="db-row">
            <input id="db-connection" className="mono" readOnly value={connection} onFocus={(event) => event.target.select()} />
            <button type="button" className="plain" onClick={() => copy(connection, "connection")}>
              {copied === "connection" ? "Copied" : "Copy"}
            </button>
          </div>
          <label className="db-label" htmlFor="db-backup">Back up everything to a file (run on your computer)</label>
          <div className="db-row">
            <input id="db-backup" className="mono" readOnly value={backupCommand} onFocus={(event) => event.target.select()} />
            <button type="button" className="plain" onClick={() => copy(backupCommand, "backup")}>
              {copied === "backup" ? "Copied" : "Copy"}
            </button>
          </div>
          <small className="muted">
            Treat this like a password: anyone with it can read and change your data. Needs PostgreSQL&apos;s free
            command-line tools, <strong>version 18 or newer</strong> (older versions refuse to back up this database).
            Restore anywhere with <span className="mono">psql &quot;new-connection&quot; -f backup.sql</span>. Tested: tables,
            relationships, timestamps and non-English text all come through intact.
          </small>
        </div>
      )}
      {error ? <p className="helptext" role="status">{error}</p> : null}
    </section>
  );
}
