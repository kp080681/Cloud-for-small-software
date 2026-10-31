"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// "Your domain" on the app page: connect the customer's own domain, show
// exactly which DNS records to add (and which old ones to delete) for the
// company that runs their DNS, re-check automatically, and remove.

const FALLBACK_ERRORS = {
  APP_NOT_LIVE: "Put this app live first, then connect your domain.",
  CUSTOM_DOMAIN_START_FAILED: "Utplava couldn't start that just now. Try again in a minute.",
};

const TONE = { ACTIVE: "live", FAILED: "failed", NEEDS_DNS: "working", SECURING: "working", PENDING: "working", REMOVING: "working" };
const LABEL = { ACTIVE: "Live", FAILED: "Couldn't connect", NEEDS_DNS: "Waiting for DNS", SECURING: "Securing", PENDING: "Connecting", REMOVING: "Removing" };

function sameDomain(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function CustomDomainCard({ workspaceId, appId, appIsLive, initialDomain }) {
  const router = useRouter();
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/domain`;
  const [domain, setDomain] = useState(initialDomain);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const lastStatus = useRef(initialDomain?.status ?? null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json();
      setDomain((current) => (sameDomain(current, body.domain) ? current : body.domain));
    } catch {
      // Offline for a moment; the next poll tries again.
    }
  }, [base]);

  // Poll while something is happening: quickly while connecting or securing,
  // slowly while waiting for the customer's DNS change to show up.
  useEffect(() => {
    if (!domain || domain.status === "ACTIVE" || domain.status === "FAILED") return undefined;
    const fast = (domain.status === "PENDING" && !domain.waitingForProof) || domain.status === "SECURING" || domain.status === "REMOVING" || domain.checking;
    const timer = setTimeout(refresh, fast ? 4000 : 20000);
    return () => clearTimeout(timer);
  }, [domain, refresh]);

  // When the domain goes live (or is removed), the page's main link changes.
  useEffect(() => {
    const status = domain?.status ?? null;
    if (status !== lastStatus.current && (status === "ACTIVE" || lastStatus.current === "ACTIVE" || status === null)) router.refresh();
    lastStatus.current = status;
  }, [domain, router]);

  async function send(path, init, action) {
    setBusy(action);
    setError("");
    try {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, ...init });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || FALLBACK_ERRORS[body.error] || "Something went wrong. Try again in a moment.");
      return body;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function connect(event) {
    event.preventDefault();
    if (!typed.trim()) return;
    const body = await send("", { body: JSON.stringify({ domain: typed }) }, "connect");
    if (body?.domain) {
      setDomain(body.domain);
      setTyped("");
    }
  }

  async function checkNow() {
    const body = await send("/check", {}, "check");
    if (body?.domain) setDomain(body.domain);
  }

  async function remove() {
    const body = await send("/remove", {}, "remove");
    setConfirmRemove(false);
    if (body) setDomain(body.removed ? null : { ...domain, status: "REMOVING", message: `Removing ${domain.domain}…`, records: [], remove: [] });
  }

  async function copy(text, key) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      // Clipboard blocked: the value is selectable on screen.
    }
  }

  if (!domain) {
    return (
      <section className="card" id="your-domain">
        <h2>Your domain</h2>
        <p className="card-sub">
          Use your own address, like <span className="mono">mybakery.com</span> or <span className="mono">app.mybakery.com</span>.
          Your utplava.dev link keeps working too.
        </p>
        <form className="inline-form domain-form" onSubmit={connect}>
          <input
            aria-label="Your domain"
            placeholder="mybakery.com"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            disabled={!appIsLive || busy === "connect"}
          />
          <button type="submit" className="button primary" disabled={!appIsLive || !typed.trim() || busy === "connect"}>
            {busy === "connect" ? "Connecting…" : "Connect domain"}
          </button>
        </form>
        {!appIsLive ? <small className="muted">Available once this app is live.</small> : null}
        {error ? <p className="domain-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  const settingUp = domain.status === "NEEDS_DNS" || domain.status === "SECURING" || domain.status === "PENDING";
  const toDelete = domain.remove ?? [];
  const toAdd = domain.records ?? [];

  return (
    <section className="card domain-card" id="your-domain">
      <h2>Your domain</h2>
      <div className="domain-head">
        <span className="mono domain-name">
          {domain.status === "ACTIVE" ? <a href={domain.url} target="_blank" rel="noreferrer">{domain.domain} ↗</a> : domain.domain}
        </span>
        <span className={`status ${TONE[domain.status] ?? ""}`}><span className="dot" aria-hidden="true" />{domain.waitingForProof ? "Prove ownership" : LABEL[domain.status] ?? domain.status}</span>
      </div>
      <p className="domain-message" aria-live="polite">{domain.message}</p>
      {domain.status === "ACTIVE" && domain.includeWww ? (
        domain.wwwReady || !toAdd.length ? (
          <small className="muted">{domain.wwwReady ? `www.${domain.domain} sends visitors here too.` : `www.${domain.domain} isn't pointing here yet.`}</small>
        ) : (
          <div className="domain-setup">
            <p className="domain-where">Optional: to make <span className="mono">www.{domain.domain}</span> work too, add this record{domain.provider?.name ? ` in ${domain.provider.name}` : ""}.</p>
            <RecordTable records={toAdd} copied={copied} onCopy={copy} prefix="www" />
          </div>
        )
      ) : null}

      {settingUp && (toDelete.length || toAdd.length) ? (
        <div className="domain-setup">
          <p className="domain-where">
            {domain.provider?.name ? <>Your domain&apos;s DNS is at <strong>{domain.provider.name}</strong>.</> : "Where you manage your domain:"}
          </p>
          <ol className="domain-steps">
            {(domain.steps ?? []).map((step) => <li key={step}>{step}</li>)}
          </ol>

          {toDelete.length ? (
            <>
              <h3 className="domain-subhead">Delete {toDelete.length === 1 ? "this old record" : "these old records"}</h3>
              <RecordTable records={toDelete} copied={copied} onCopy={copy} prefix="del" />
            </>
          ) : null}
          {toAdd.length ? (
            <>
              <h3 className="domain-subhead">Add {toAdd.length === 1 ? "this record" : "these records"}</h3>
              <RecordTable records={toAdd} copied={copied} onCopy={copy} prefix="add" />
            </>
          ) : null}
          <small className="muted">
            Changes usually show up within minutes, sometimes a few hours. Utplava keeps checking, so you can close this page.
            If it isn&apos;t set up within 14 days, the domain is released.
          </small>
        </div>
      ) : null}

      {error ? <p className="domain-error" role="alert">{error}</p> : null}

      <div className="domain-actions">
        {settingUp ? (
          <button type="button" onClick={checkNow} disabled={busy !== "" || domain.checking}>
            {busy === "check" || domain.checking ? "Checking…" : "Check now"}
          </button>
        ) : null}
        {domain.status !== "REMOVING" ? (
          confirmRemove ? (
            <>
              <p className="domain-confirm">
                Visitors to {domain.domain} will stop reaching this app. Afterwards, delete the records you added
                {domain.provider?.name ? ` in ${domain.provider.name}` : " at your domain provider"}, so the address can&apos;t be used by anyone else.
              </p>
              <button type="button" className="danger" onClick={remove} disabled={busy !== ""}>
                {busy === "remove" ? "Removing…" : `Remove ${domain.domain}`}
              </button>
              <button type="button" className="plain" onClick={() => setConfirmRemove(false)} disabled={busy !== ""}>Keep it</button>
            </>
          ) : (
            <button type="button" className="plain" onClick={() => setConfirmRemove(true)} disabled={busy !== ""}>
              {domain.status === "FAILED" ? "Try a different domain" : "Remove domain"}
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}

function RecordTable({ records, copied, onCopy, prefix }) {
  return (
    <div className="dns-records" role="table" aria-label="DNS records">
      <div className="dns-row dns-header" role="row">
        <span role="columnheader">Type</span>
        <span role="columnheader">Name</span>
        <span role="columnheader">Value</span>
      </div>
      {records.map((record, index) => {
        const key = `${prefix}-${index}`;
        return (
          <div className="dns-row" role="row" key={key}>
            <span className="mono" role="cell">{record.type}</span>
            <span className="mono" role="cell">
              {record.name}
              <button type="button" className="copy" onClick={() => onCopy(record.name, `${key}-n`)} aria-label={`Copy name ${record.name}`}>
                {copied === `${key}-n` ? "Copied" : "Copy"}
              </button>
            </span>
            <span className="mono dns-value" role="cell">
              {record.value}
              <button type="button" className="copy" onClick={() => onCopy(record.value, `${key}-v`)} aria-label={`Copy value ${record.value}`}>
                {copied === `${key}-v` ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
