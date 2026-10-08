import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = process.cwd(), out = path.join(root, 'artifacts', 'preparation-options-validation');
await fs.mkdir(out, { recursive: true });
await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {PreparationOptionsModal} from './src/renderer/preparation-options'; import './src/renderer/styles.css';
  const session={id:'session',title:'量化误差分析',messages:[{id:'m',role:'user',text:'补充误差样例',createdAt:'now'}]};
  function App(){const[open,setOpen]=useState(true);return open?<PreparationOptionsModal session={session} close={()=>setOpen(false)} started={async(scope,categories,directions)=>{window.submission={scope,categories,directions};}}/>:<button onClick={()=>setOpen(true)}>重新打开整理</button>}
  createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(out, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => { window.calls = []; window.workbench = { call: async action => { window.calls.push(action); throw Error('整理选项不应读取旧配置接口'); } }; });
try {
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const choices = page.getByRole('checkbox');
  await expect(choices).toHaveCount(3);
  for (const name of ['已有能力', '探索记录', '待办事项']) await expect(page.getByRole('checkbox', { name: new RegExp(name) })).toBeChecked();
  await expect(page.getByText('项目目标', { exact: true })).toHaveCount(0);
  await expect(page.getByText('项目资料', { exact: true })).toHaveCount(0);
  await expect(page.locator('select')).toHaveCount(0);
  checks.push('三类默认勾选，无场景、组合配置或其他类别');
  await expect(page.getByLabel('已有能力的整理方向')).not.toBeVisible();
  await page.locator('.preparation-direction').first().locator('summary').click();
  await page.getByLabel('已有能力的整理方向').fill('只整理批处理能力');
  await page.getByRole('checkbox', { name: /已有能力/ }).uncheck();
  await page.getByRole('checkbox', { name: /探索记录/ }).uncheck();
  await page.getByRole('checkbox', { name: /待办事项/ }).uncheck();
  await expect(page.getByRole('button', { name: '开始整理对话', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('请至少选择一个整理方面');
  checks.push('空选择不可提交，取消某类后收起该类要求');
  await page.getByRole('checkbox', { name: /待办事项/ }).check();
  await page.locator('.preparation-direction summary').click();
  await page.getByLabel('待办事项的整理方向').fill('  补充长尾验证\n保留验收条件  ');
  await page.setViewportSize({ width: 760, height: 760 });
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  if (await page.locator('.preparation-dialog').evaluate(element => element.scrollWidth > element.clientWidth + 1)) throw Error('整理窗口出现横向溢出');
  await page.screenshot({ path: path.join(out, 'selected-todo.png') });
  await page.getByRole('button', { name: '开始整理对话', exact: true }).click();
  const submission = await page.evaluate(() => window.submission);
  expect(submission).toEqual({ scope: 'full', categories: ['todo'], directions: { todo: '补充长尾验证\n保留验收条件' } });
  checks.push('只提交用户所选类别和该类要求；窄窗口无溢出');
  await page.getByRole('button', { name: '重新打开整理' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新打开整理' })).toBeVisible();
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  checks.push('取消能退出，整个流程不调用分类配置接口');
  if (errors.length) throw Error(errors.join('\n'));
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(checks.join('\n'));
} finally { await browser.close(); }
