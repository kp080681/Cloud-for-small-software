import { cookies } from "next/headers";
import { connectDatabase } from "./db.mjs";
import {
  assertAuthenticatedSession,
  publicSession,
  selectedWorkspaceCookieName,
  sessionCookieName,
  unsealSession,
} from "./session.mjs";
import {
  defaultWorkspaceName,
  ensureInitialWorkspace,
  getAuthorizedWorkspace,
  listAuthorizedWorkspaces,
  listWorkspaceApplications,
} from "./customer-workspaces.mjs";
import {
  listSelectedWorkspaceRepositories,
  listWorkspaceGitHubInstallations,
} from "./customer-github.mjs";
import { listWorkspaceConfigurationStatuses } from "./customer-configuration.mjs";
import { listWorkspaceRepositoryAnalyses } from "./repository-analysis.mjs";

export async function readCurrentSession(cookieStore = null) {
  const store = cookieStore ?? (await cookies());
  const value = store.get(sessionCookieName)?.value;
  return unsealSession(value);
}

export async function getCustomerShell({ selectedWorkspaceId = null } = {}) {
  const session = await readCurrentSession();
  if (!session) return { authenticated: false };

  const db = await connectDatabase();
  try {
    const initialWorkspace = await ensureInitialWorkspace(db, {
      customerId: session.customerId,
      workspaceName: defaultWorkspaceName(session),
    });
    const workspaces = await listAuthorizedWorkspaces(db, { customerId: session.customerId });

    let currentWorkspace = initialWorkspace;
    if (selectedWorkspaceId) {
      currentWorkspace = await getAuthorizedWorkspace(db, {
        customerId: session.customerId,
        workspaceId: selectedWorkspaceId,
      }).catch(() => initialWorkspace);
    } else {
      const cookieWorkspaceId = (await cookies()).get(selectedWorkspaceCookieName)?.value;
      if (cookieWorkspaceId) {
        currentWorkspace = await getAuthorizedWorkspace(db, {
          customerId: session.customerId,
          workspaceId: cookieWorkspaceId,
        }).catch(() => initialWorkspace);
      }
    }

    const apps = await listWorkspaceApplications(db, {
      customerId: session.customerId,
      workspaceId: currentWorkspace.id,
    });
    const githubInstallations = await listWorkspaceGitHubInstallations(db, {
      customerId: session.customerId,
      workspaceId: currentWorkspace.id,
    });
    const selectedRepositories = await listSelectedWorkspaceRepositories(db, {
      customerId: session.customerId,
      workspaceId: currentWorkspace.id,
    });
    const repositoryAnalyses = await listWorkspaceRepositoryAnalyses(db, {
      customerId: session.customerId,
      workspaceId: currentWorkspace.id,
    });
    const configurationStatuses = await listWorkspaceConfigurationStatuses(db, {
      customerId: session.customerId,
      workspaceId: currentWorkspace.id,
    });

    return {
      ...publicSession(session),
      workspaces,
      selectedWorkspaceId: currentWorkspace.id,
      currentWorkspace,
      apps,
      github: {
        connected: githubInstallations.length > 0,
        installations: githubInstallations,
        selectedRepositories,
        repositoryAnalyses,
        configurationStatuses,
      },
    };
  } finally {
    await db.end();
  }
}

export async function requireCustomerSession(cookieStore = null) {
  return assertAuthenticatedSession(await readCurrentSession(cookieStore));
}
