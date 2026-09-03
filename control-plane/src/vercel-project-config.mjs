export function sscManagedProjectGitSettings() {
  return {
    skipGitConnectDuringLink: true,
  };
}

export function disableGitAutoDeploymentsBody() {
  return {
    git: {
      deploymentEnabled: false,
    },
  };
}

export function gitAutoDeploymentsDisabled(project) {
  const disconnected = !project?.git && !project?.link;
  return disconnected || project?.git?.deploymentEnabled === false;
}
