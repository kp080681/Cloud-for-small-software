function id(value) {
  return value === null || value === undefined ? null : String(value);
}

function fail(message) {
  throw new Error(message);
}

export function assertAppInWorkspace(app, workspaceId) {
  if (!app) fail("App is required for workspace ownership validation");
  if (id(app.workspaceId ?? app.workspace_id) !== id(workspaceId)) {
    fail("App does not belong to the requested workspace");
  }
  return app;
}

export function assertRepositoryInWorkspace(repository, workspaceId) {
  if (!repository) fail("Repository is required for workspace ownership validation");
  if (id(repository.workspaceId ?? repository.workspace_id) !== id(workspaceId)) {
    fail("Repository does not belong to the requested workspace");
  }
  return repository;
}

export function assertDeploymentInWorkspace(deployment, workspaceId) {
  if (!deployment) fail("Deployment is required for workspace ownership validation");
  if (id(deployment.workspaceId ?? deployment.workspace_id) !== id(workspaceId)) {
    fail("Deployment does not belong to the requested workspace");
  }
  return deployment;
}

export function assertDeploymentBelongsToApp(deployment, app) {
  if (!deployment || !app) fail("Deployment and app are required for ownership validation");
  if (id(deployment.appId ?? deployment.app_id) !== id(app.id)) {
    fail("Deployment does not belong to the app");
  }
  if (id(deployment.workspaceId ?? deployment.workspace_id) !== id(app.workspaceId ?? app.workspace_id)) {
    fail("Deployment workspace does not match app workspace");
  }
  return deployment;
}

export function assertSecretBindingBelongsToApp(binding, app) {
  if (!binding || !app) fail("Secret binding and app are required for ownership validation");
  if (id(binding.bindingAppId ?? binding.binding_app_id ?? binding.appId ?? binding.app_id) !== id(app.id)) {
    fail("Secret binding does not belong to the app");
  }
  if (id(binding.bindingWorkspaceId ?? binding.binding_workspace_id ?? binding.workspaceId ?? binding.workspace_id) !== id(app.workspaceId ?? app.workspace_id)) {
    fail("Secret binding workspace does not match app workspace");
  }
  if (id(binding.secretAppId ?? binding.secret_app_id) !== id(app.id)) {
    fail("Secret does not belong to the bound app");
  }
  if (id(binding.secretWorkspaceId ?? binding.secret_workspace_id) !== id(app.workspaceId ?? app.workspace_id)) {
    fail("Secret workspace does not match bound app workspace");
  }
  return binding;
}

export function assertRuntimeBelongsToApp(runtime, app) {
  if (!runtime || !app) fail("Runtime and app are required for ownership validation");
  if (id(runtime.runtimeAppId ?? runtime.runtime_app_id ?? runtime.appId ?? runtime.app_id) !== id(app.id)) {
    fail("Runtime does not belong to the app");
  }
  if (id(runtime.runtimeWorkspaceId ?? runtime.runtime_workspace_id ?? runtime.workspaceId ?? runtime.workspace_id) !== id(app.workspaceId ?? app.workspace_id)) {
    fail("Runtime workspace does not match app workspace");
  }
  return runtime;
}

export function assertRuntimeMatchesDeployment(runtime, deployment) {
  if (!runtime || !deployment) fail("Runtime and deployment are required for ownership validation");
  const deploymentRuntimeProjectId = id(deployment.runtimeProjectId ?? deployment.runtime_project_id);
  const providerProjectId = id(runtime.providerProjectId ?? runtime.provider_project_id);
  if (deploymentRuntimeProjectId && providerProjectId && deploymentRuntimeProjectId !== providerProjectId) {
    fail("Deployment runtime project binding does not match app runtime");
  }
  if (id(runtime.runtimeAppId ?? runtime.runtime_app_id ?? runtime.appId ?? runtime.app_id) !== id(deployment.appId ?? deployment.app_id)) {
    fail("Runtime app does not match deployment app");
  }
  if (id(runtime.runtimeWorkspaceId ?? runtime.runtime_workspace_id ?? runtime.workspaceId ?? runtime.workspace_id) !== id(deployment.workspaceId ?? deployment.workspace_id)) {
    fail("Runtime workspace does not match deployment workspace");
  }
  return runtime;
}

export function assertProviderBuildBelongsToDeployment(build, deployment) {
  if (!build || !deployment) fail("Provider build and deployment are required for ownership validation");
  if (id(build.deploymentId ?? build.deployment_id) !== id(deployment.id)) {
    fail("Provider build does not belong to the deployment");
  }
  const buildSource = id(build.sourceCommitSha ?? build.source_commit_sha);
  const deploymentSource = id(deployment.sourceCommitSha ?? deployment.source_commit_sha);
  if (buildSource && deploymentSource && buildSource !== deploymentSource) {
    fail("Provider build source identity does not match deployment source");
  }
  return build;
}

export function assertProviderOperationBelongsToDeployment(operation, deployment) {
  if (!operation || !deployment) fail("Provider operation and deployment are required for ownership validation");
  if (id(operation.deploymentId ?? operation.deployment_id) !== id(deployment.id)) {
    fail("Provider operation does not belong to the deployment");
  }
  const operationSource = id(operation.sourceCommitSha ?? operation.source_commit_sha);
  const deploymentSource = id(deployment.sourceCommitSha ?? deployment.source_commit_sha);
  if (operationSource && deploymentSource && operationSource !== deploymentSource) {
    fail("Provider operation source identity does not match deployment source");
  }
  return operation;
}

export function assertSscProviderResourceIdentity(resource, deployment) {
  if (!resource || !deployment) fail("Provider resource and deployment are required for ownership validation");
  const meta = resource.meta && typeof resource.meta === "object" ? resource.meta : {};
  if (id(meta.sscDeploymentId) !== id(deployment.id)) {
    fail("Provider resource SSC deployment identity does not match deployment");
  }
  if (id(meta.sscSourceCommitSha) !== id(deployment.sourceCommitSha ?? deployment.source_commit_sha)) {
    fail("Provider resource SSC source identity does not match deployment");
  }
  return resource;
}
