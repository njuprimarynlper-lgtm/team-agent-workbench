import { expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 20000 });
export async function completeProjectDirectory(page, directory = '') {
  const dialog = page.getByRole('dialog', { name: '设置项目代码目录', exact: true });
  await expect(dialog).toBeVisible();
  if (directory) {
    await dialog.getByLabel('代码目录（选填）', { exact: true }).fill(directory);
    await dialog.getByRole('button', { name: '保存并进入项目', exact: true }).click();
  } else await dialog.getByRole('button', { name: '暂不设置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
export async function completeProjectSetup(page, name, directory = '') {
  const dialog = page.getByRole('dialog', { name: '完善项目资料', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByLabel('引导项目名称').fill(name);
  await dialog.getByLabel('项目背景', { exact: true }).fill('需要团队共同整理资料、推进方案并共享验证结论。');
  await dialog.getByLabel('项目目标', { exact: true }).fill('形成可复用方案，提高团队协作效率与交付质量。');
  await dialog.getByLabel('验收标准', { exact: true }).fill('按项目约定完成验证，由负责人检查成果和证据。');
  await dialog.getByRole('button', { name: '保存并创建项目', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await completeProjectDirectory(page, directory);
}
