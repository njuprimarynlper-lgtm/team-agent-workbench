import { expect } from '@playwright/test';
import fs from 'node:fs/promises';

export async function importConnection({ page }, file) {
  const profile = JSON.parse(await fs.readFile(file, 'utf8'));
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

export async function exportConnection({ app, page }, username, file) {
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
  await page.evaluate(username => window.admin.call('member.export', { username }), username);
}
