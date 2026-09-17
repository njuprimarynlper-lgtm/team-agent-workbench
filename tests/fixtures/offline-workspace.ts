import type { Workbench } from '../../src/core/workbench';
import { makeAuthorization } from '../../src/core/workspace-access';
export const offlineProjectId = 'project_' + 'a'.repeat(32);
export function grantTestWorkspace(wb: Workbench, cwd: string) {
  wb.workspaceReady = true; wb.store.settings.verifiedLocalWorkspace = cwd;
  wb.store.settings.offlineAuthorization = makeAuthorization({ id: 'offline-test', name: 'offline fixture', host: 'test.invalid', port: 22, username: 'alice', fingerprint: 'test', manifestPath: '', projects: [{ id: offlineProjectId, name: '测试项目', groupName: 'test_group', remoteRoot: '/projects/test/P', uploadPath: '/projects/test/P/submissions/alice', historyPath: '/projects/test/P/trajectories/alice' }] }, [{ path: '/projects/test', canonicalPath: '/projects/test', groupName: 'test_group', canCreateProject: false }]);
}
