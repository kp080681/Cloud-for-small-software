export function runtimeRecoveryAction({ localRuntime, remoteProject }) {
  if (localRuntime) return { action: "use-local-runtime" };
  if (remoteProject) return { action: "reconcile-remote-project" };
  return { action: "create-project" };
}
