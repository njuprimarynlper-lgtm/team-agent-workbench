import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = path.resolve('.test-data/guard-ui');
await fs.mkdir(root, { recursive: true });
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CodexRequestGuardSetting, GuardConnectionError} from './src/renderer/codex-request-guard';
import './src/renderer/styles.css';
window.fixture={chosen:'',checks:[],configured:0,ok:false};
const problem={stage:'target_tls',code:'SELF_SIGNED_CERT_IN_CHAIN',viaProxy:true};
function App(){const[on,setOn]=useState(true),[file,setFile]=useState('');
 const check=async(route)=>{window.fixture.checks.push({route,file});return window.fixture.ok?{ok:true,message:'网络连接和证书验证通过。未调用模型。'}:{ok:false,problem,message:'无法验证代理连接提供的证书，请检查企业证书设置。'};};
 return <main style={{width:'min(720px,calc(100% - 32px))',margin:'24px auto',padding:24,background:'white',borderRadius:12}}>
 <section aria-label="对话错误"><GuardConnectionError message="原始错误[WB_NET|target_tls|SELF_SIGNED_CERT_IN_CHAIN|proxy]" configure={()=>window.fixture.configured++} testConnection={()=>check('management')}/></section>
 <h2>agent管理</h2><CodexRequestGuardSetting enabled={on} changed={setOn} certificateFile={file} certificateChanged={setFile} chooseCertificate={async()=>window.fixture.chosen} testConnection={check}/></main>;
}createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, outfile: path.join(root, 'ui.js'), logLevel: 'silent' });
await fs.writeFile(path.join(root, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  const error = page.getByRole('region', { name: '对话错误' });
  await expect(page.locator('body')).not.toContainText('WB_NET');
  await error.getByRole('button', { name: '设置企业证书' }).click();
  expect(await page.evaluate(() => window.fixture.configured)).toBe(1);
  await error.getByText('查看详情', { exact: true }).click();
  await expect(error).toContainText('SELF_SIGNED_CERT_IN_CHAIN');
  const toggle = page.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByText('企业证书与连接检测', { exact: true }).click();
  const file = page.getByRole('textbox', { name: '企业证书路径' });
  await file.fill('C:\\company\\root.pem');
  await page.getByRole('button', { name: '选择证书' }).click();
  await expect(file).toHaveValue('C:\\company\\root.pem'); // Cancel preserves the draft.
  await page.evaluate(() => { window.fixture.chosen = 'C:\\company\\new-root.pem'; });
  await page.getByRole('button', { name: '选择证书' }).click();
  await expect(file).toHaveValue('C:\\company\\new-root.pem');
  await page.getByRole('combobox', { name: '检测使用的网络' }).selectOption('management');
  await page.getByRole('button', { name: '检测连接', exact: true }).click();
  expect(await page.evaluate(() => window.fixture.checks.at(-1))).toEqual({ route: 'management', file: 'C:\\company\\new-root.pem' });
  await page.screenshot({ path: path.join(root, 'enterprise-certificate.png'), fullPage: true, animations: 'disabled' });
  await page.evaluate(() => { window.fixture.ok = true; });
  await error.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(error).toContainText('连接检查通过，可继续对话。');
  await expect(error.getByText('查看详情', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await expect(file).toHaveValue('');
  console.log('PASS: switch, certificate cancel/select/clear, route selection, sanitized diagnostics and connection recovery.');
} finally { await browser.close(); }
