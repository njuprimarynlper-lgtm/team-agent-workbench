import { expect } from '@playwright/test';

export async function importConnection({ app, page }, file) {
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  await page.getByRole('button', { name: '导入管理员配置', exact: true }).click();
  await expect(page.getByLabel('团队连接说明')).toContainText('团队连接：');
  await expect(page.getByLabel('本地共享区根目录', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择共享目录', exact: true })).toHaveCount(0);
}

export async function exportConnection({ app, page }, username, file) {
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
  await page.locator('tbody tr').filter({ hasText: username }).getByRole('button', { name: '导出连接配置', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
}
