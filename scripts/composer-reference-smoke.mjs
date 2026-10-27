import { expect } from '@playwright/test';

export async function openComposerReferences(page) {
  const button = page.locator('.composer-wrap .composer-reference-more');
  await expect(button).toBeEnabled();
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  return page.getByLabel('全部待发送资料', { exact: true });
}

export async function expectComposerReference(page, title) {
  const list = await openComposerReferences(page);
  await expect(list).toContainText(title);
  await list.getByRole('button', { name: '关闭参考资料', exact: true }).click();
}

export async function expectSelectedComposerReferences(page, count) {
  const button = page.locator('.composer-wrap .composer-reference-more');
  if (await button.isDisabled()) { expect(count).toBe(0); return; }
  const list = await openComposerReferences(page);
  await expect(list.locator('input[type="checkbox"]:checked:not(:disabled)')).toHaveCount(count);
  await list.getByRole('button', { name: '关闭参考资料', exact: true }).click();
}
