import Link from "next/link";
import { WorkspaceSelectForm } from "./workspace-forms.js";

// Shared, server-rendered pieces of the dashboard: the sunrise mark, the
// header (brand, workspace switcher, initials menu) and the two-item
// sidebar. Every page threads ?workspace= through its links, because the
// selected workspace lives in the URL (the cookie is only set at sign-in).

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect className="mark-tile" x="0.5" y="0.5" width="23" height="23" rx="5.4" />
      <line className="mark-horizon" x1="3.75" y1="16.4" x2="20.25" y2="16.4" />
      <path className="mark-sun" d="M 5,16.4 A 7,7 0 0 1 19,16.4 Z" />
    </svg>
  );
}

export function Brand({ href = null }) {
  const inner = (
    <>
      <Mark />
      utplava
    </>
  );
  return href ? (
    <Link className="brand" href={href} style={{ textDecoration: "none" }}>{inner}</Link>
  ) : (
    <div className="brand">{inner}</div>
  );
}

export function Status({ children, tone = "neutral" }) {
  return (
    <span className={`status ${tone}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function workspaceHref(path, workspaceId) {
  return `${path}?workspace=${encodeURIComponent(workspaceId)}`;
}

const RUNNING = new Set(["ANALYZING", "QUEUED", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING"]);

// One status badge per app, from the latest deployment and whether a live
// version exists. A running redeploy of a live app reads "Deploying", not
// "Not live": the previous version is still serving.
export function appStatus(app) {
  const latest = app.latestDeploymentStatus;
  // An ANALYZING deployment only counts once it has actually been started
  // (an analysed-but-never-deployed commit is not "deploying").
  if (latest && RUNNING.has(latest) && (latest !== "ANALYZING" || app.latestDeploymentStarted)) return { tone: "working", label: "Deploying" };
  if (latest === "FAILED" && !app.liveUrl) return { tone: "failed", label: "Failed" };
  if (app.liveUrl) return { tone: "live", label: "Live" };
  return { tone: "neutral", label: "Not live" };
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function Chrome({ shell, active, children }) {
  const workspaceId = shell.currentWorkspace.id;
  const login = shell.user.login;
  return (
    <>
      <header>
        <div className="header-left">
          <Brand href={workspaceHref("/", workspaceId)} />
          <WorkspaceSelectForm workspaces={shell.workspaces} selectedWorkspaceId={workspaceId} />
        </div>
        <div className="header-right">
          <details className="user-menu">
            <summary aria-label="Account menu">
              <span className="avatar">{login.slice(0, 2).toUpperCase()}</span>
            </summary>
            <div className="user-menu-panel">
              <div className="who">
                <strong>{login}</strong>
                Signed in with GitHub
              </div>
              <Link className="menu-item" href={workspaceHref("/settings", workspaceId)}>Settings</Link>
              <form action="/api/auth/sign-out" method="post">
                <button type="submit">Sign out</button>
              </form>
            </div>
          </details>
        </div>
      </header>
      <div className="shell">
        <aside>
          <Link className={`nav-link${active === "apps" ? " active" : ""}`} href={workspaceHref("/", workspaceId)}>Apps</Link>
          <Link className={`nav-link${active === "settings" ? " active" : ""}`} href={workspaceHref("/settings", workspaceId)}>Settings</Link>
        </aside>
        <main id="main-content">{children}</main>
      </div>
    </>
  );
}
