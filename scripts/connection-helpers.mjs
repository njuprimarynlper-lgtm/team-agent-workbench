import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';

export async function setConnectionProfile({ page }, profile) {
  await page.evaluate(async profile => {
    const snapshot = await window.workbench.call('snapshot');
    await window.workbench.call('settings.save', { ...snapshot.settings, connections: [...snapshot.settings.connections.filter(item => item.id !== profile.id), profile] });
  }, profile);
  await page.locator('.modal').getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '配置账号与本机目录', exact: true }).click();
  const selector = page.getByLabel('团队连接（已保存）');
  if (await selector.count()) await selector.selectOption(profile.id);
  await expect(page.getByLabel('团队连接说明')).toContainText('团队连接：');
  await expect(page.getByLabel('本地共享区根目录', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择共享目录', exact: true })).toHaveCount(0);
}

export async function memberProfile({ page }, username) {
  const snapshot = await page.evaluate(() => window.admin.call('snapshot'));
  const user = snapshot.state?.users?.[username];
  if (!snapshot.profile || !user) throw new Error('测试成员不存在：' + username);
  const id = (snapshot.profile.mode === 'local' ? 'local_' : 'member_') + createHash('sha256').update(JSON.stringify([snapshot.state.teamId, username])).digest('hex').slice(0, 40);
  return { mode: snapshot.profile.mode, localRoot: snapshot.profile.localRoot, id, name: user.name || username, host: snapshot.profile.host, port: snapshot.profile.port, username, fingerprint: snapshot.profile.fingerprint, manifestPath: '', projects: [], workPath: '' };
}
