// Desktop smoke tests seed a previously verified workspace, never bypass the group gate.
export const offlineProjectId = 'project_' + 'a'.repeat(32);
export function offlineSettings() {
  return { workspaceSnapshot: { profile: { id: 'offline-test', name: '测试组', host: 'test.invalid', port: 22, username: 'alice', fingerprint: 'fixture', manifestPath: '', projects: [{ id: offlineProjectId, name: '测试项目', groupName: 'test_group', groupLabel: '测试组', remoteRoot: '/projects/test/P', uploadPath: '/projects/test/P/submissions/alice', historyPath: '/projects/test/P/trajectories/alice' }] }, workspaces: [{ path: '/projects/test', canonicalPath: '/projects/test', groupName: 'test_group', groupLabel: '测试组', canCreateProject: false }] } };
}
