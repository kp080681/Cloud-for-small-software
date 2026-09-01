export function disableGitAutoDeploymentsBody() {
  return {
    git: {
      deploymentEnabled: false,
    },
  };
}

export function gitAutoDeploymentsDisabled(project) {
  return project?.git?.deploymentEnabled === false;
}
