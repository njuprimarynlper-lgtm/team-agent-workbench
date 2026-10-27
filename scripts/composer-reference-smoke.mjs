import { expect } from '@playwright/test';

export async function openComposerReferences(page, title) {
  const button = page.locator('.composer-wrap .composer-reference-more');
  const tabs = page.locator('.composer-wrap .composer-reference-tab');
  await expect.poll(async () => await button.count() + await tabs.count()).toBeGreaterThan(0);
  if (await button.count()) {
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  } else {
    await (title ? tabs.filter({ hasText: title }) : tabs).first().click();
  }
  return page.locator('.composer-wrap .composer-reference-panel');
}

export async function expectComposerReference(page, title) {
  const list = await openComposerReferences(page, title);
  await expect(list).toContainText(title);
  await list.getByRole('button', { name: '关闭参考资料', exact: true }).click();
}

export async function expectSelectedComposerReferences(page, count) {
  const button = page.locator('.composer-wrap .composer-reference-more');
  if (await button.count()) {
    const list = await openComposerReferences(page);
    await expect(list.locator('input[type="checkbox"]:checked:not(:disabled)')).toHaveCount(count);
    await list.getByRole('button', { name: '关闭参考资料', exact: true }).click();
  } else {
    let selected = 0;
    for (const tab of await page.locator('.composer-wrap .composer-reference-tab').all()) {
      await tab.click();
      const panel = page.locator('.composer-wrap .composer-reference-panel');
      selected += await panel.locator('input[type="checkbox"]:checked:not(:disabled)').count();
      await panel.getByRole('button', { name: '关闭参考资料', exact: true }).click();
    }
    expect(selected).toBe(count);
  }
}
