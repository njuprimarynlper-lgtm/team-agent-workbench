import type { Workbench } from '../../src/core/workbench';

// Tests that operate on shared files explicitly await the background creation.
// Creation is confirmed by the central node; await subsequent sync for shared-file assertions.
export async function syncedProject(workbench: Workbench, ...args: Parameters<Workbench['createProject']>) {
  const project = await workbench.createProject(...args);
  await workbench.projectSync.sync();
  const state = workbench.projectSync.states()[project.id];
  if (state?.error) throw new Error(state.error);
  return workbench.projectBinding(project.id).project;
}
