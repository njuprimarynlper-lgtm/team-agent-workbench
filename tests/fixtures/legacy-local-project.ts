import type { Workbench } from '../../src/core/workbench';
import type { ProjectBrief } from '../../src/shared/project-brief';

// Seed old on-disk data to test upgrade compatibility. Production creation no
// longer exposes a local-only project path.
export async function legacyLocalProject(workbench: Workbench, name: string, brief?: ProjectBrief) {
  const project = await workbench.projectSync.create(name, undefined, brief, true);
  await workbench.restoreLocalWorkspace(); return project;
}
