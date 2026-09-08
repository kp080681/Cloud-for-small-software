"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function WorkspaceSelectForm({ workspaces, selectedWorkspaceId }) {
  const router = useRouter();

  return (
    <select
      className="workspace-select"
      aria-label="Workspace"
      value={selectedWorkspaceId}
      onChange={(event) => router.push(`/?workspace=${encodeURIComponent(event.target.value)}`)}
    >
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
      ))}
    </select>
  );
}

export function WorkspaceRenameForm({ workspace }) {
  const router = useRouter();
  const [name, setName] = useState(workspace.name);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setMessage(body.error || "Workspace could not be renamed.");
      return;
    }
    setMessage("Workspace renamed.");
    startTransition(() => router.refresh());
  }

  return (
    <form className="workspace-form" onSubmit={submit}>
      <label htmlFor="workspace-name">Workspace name</label>
      <div className="inline-form">
        <input
          id="workspace-name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <button disabled={isPending || name.trim() === workspace.name}>Save name</button>
      </div>
      {message ? <p className="helptext" role="status">{message}</p> : null}
    </form>
  );
}
