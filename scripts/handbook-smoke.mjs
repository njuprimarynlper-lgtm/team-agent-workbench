import {chromium,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.cwd(), url=pathToFileURL(process.env.HANDBOOK_FILE || path.join(root,'docs/handbook/index.html')).href;
const output=path.join(root,'.test-data',process.env.HANDBOOK_FILE?'handbook-package-ui':'handbook-ui');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.setOffline(true);
const page=await context.newPage();const errors=[];const requests=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
try{
 await page.goto(url);await expect(page.locator('article h1')).toHaveText('开始使用');
 await expect(page.getByRole('heading',{name:'按任务查找',exact:true})).toBeVisible();
 await expect(page.locator('#navigation .nav-group-home')).toHaveText('开始使用');
 await expect(page.locator('#navigation .nav-group-home')).toHaveAttribute('aria-current','page');
 await page.locator('.download-menu summary').click();
 const editionLinks=await page.locator('.download-menu a').evaluateAll(links=>links.map(a=>a.href));
 expect(editionLinks).toHaveLength(3);
 for(const link of editionLinks) await fs.access(fileURLToPath(link));
 await page.locator('.download-menu summary').click();
 await page.screenshot({path:path.join(output,'home.png'),fullPage:false});
 await page.locator('.role-card[href="#quickstart-member"]').click();await expect(page.locator('article h1')).toHaveText('成员快速上手');
 await page.locator('.path-list a[href="#section-4-1"]').click();await expect(page).toHaveURL(/#section-4-1$/);
 await expect(page.locator('#section-4-1')).toBeVisible();
 await page.goBack();await expect(page.locator('article h1')).toHaveText('成员快速上手');
 await page.keyboard.press('Control+k');await page.getByRole('searchbox').fill('怎么加人');
 await expect(page.locator('.search-result').first()).toContainText(/成员|账号/);
 await page.screenshot({path:path.join(output,'search.png'),fullPage:false});
 await page.getByRole('searchbox').fill('上传成果');await expect(page.locator('.search-result')).not.toHaveCount(0);
 await page.getByRole('searchbox').press('Enter');await expect(page.getByRole('dialog',{name:'搜索手册',exact:true})).not.toBeVisible();
 await page.goto(url+'#section-6-3');await expect(page.locator('#section-6-3')).toBeVisible();
 await expect(page.locator('#section-6-3')).toHaveText(/核对并上传团队成果/);
 await page.waitForTimeout(150);
 await page.screenshot({path:path.join(output,'steps.png'),fullPage:false});
 await page.getByRole('button',{name:'复制链接',exact:true}).click();
 const copyDialog=page.getByRole('dialog',{name:'复制当前章节链接',exact:true});
 if(await copyDialog.isVisible()){await expect(page.getByLabel('当前链接',{exact:true})).toHaveValue(/#section-6-3$/);await copyDialog.getByRole('button',{name:'关闭',exact:true}).click();}
 else await expect(page.getByRole('status').last()).toContainText('当前链接已复制');
 for(const [section,alt] of [
  ['roles','正式部署中总管理员、项目组管理员、成员 A 和 B 独立节点及两类服务的拓扑图'],
  ['deployment','正式部署中总管理员、项目组管理员、成员 A 和 B 独立节点及两类服务的拓扑图'],
  ['references','项目成果进入会话的四步流程示意'],
  ['share-results','成果整理、审核、附件上传和发布的流程示意'],
  ['conclusions','本地项目成果的账号同步范围示意'],
  ['tasks','任务派发、工作、提交验收、审核及退回的流程示意'],
 ]){
  await page.goto(url+'#'+section);
  const diagram=page.locator(`img[alt="${alt}"]`);
  await expect(diagram).toBeVisible();
  expect(await diagram.evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
 }
 await page.goto(url+'#egress-reference');
 await expect(page.getByRole('heading',{name:/先判断是否需要/})).toBeVisible();
 await page.goto(url+'#roles');
 await page.locator('.zoom-image').first().click();
 await expect(page.getByRole('dialog',{name:'放大查看配图',exact:true})).toBeVisible();await page.keyboard.press('Escape');
 await page.goto(url+'#people');await page.getByRole('button',{name:/放大查看/}).first().click();
 await expect(page.getByRole('dialog',{name:'放大查看配图',exact:true})).toBeVisible();await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog',{name:'放大查看配图',exact:true})).not.toBeVisible();
 await page.goto(url+'#not-a-section');await expect(page.getByRole('heading',{name:'没有找到这个位置'})).toBeVisible();
 await page.getByRole('link',{name:'开始使用',exact:true}).click();await expect(page.locator('article h1')).toHaveText('开始使用');
 // Every topic and every section target can be opened from a fresh hash.
 const targets=await page.evaluate(()=>{const data=JSON.parse(document.getElementById('manual-data').textContent);return data.flatMap(a=>[a.id,...a.headings.map(h=>h.id)]);});
 const brokenLinks=await page.evaluate(valid=>{
  const data=JSON.parse(document.getElementById('manual-data').textContent), errors=[];
  for(const article of data){const html=new DOMParser().parseFromString(article.html,'text/html');for(const a of html.querySelectorAll('a[href^="#"]')){if(!valid.includes(a.getAttribute('href').slice(1)))errors.push({article:article.id,link:a.getAttribute('href')});}}
  return errors;
 },targets);expect(brokenLinks).toEqual([]);
 for(const target of targets){
  await page.evaluate(hash=>{location.hash=hash;},target);
  await expect(page.getByRole('heading',{name:'没有找到这个位置'})).toHaveCount(0);
  await expect.poll(()=>page.evaluate(t=>{const data=JSON.parse(document.getElementById('manual-data').textContent);const topic=data.find(a=>a.id===t);const quickstarts={'quickstart-member':'成员快速上手','quickstart-lead':'项目组管理员快速上手','quickstart-admin':'总管理员快速上手'};return topic?document.querySelector('article h1')?.textContent===topic.title:quickstarts[t]?document.querySelector('article h1')?.textContent===quickstarts[t]:!!document.getElementById(t);},target)).toBe(true);
 }
 const sidebarLinks=await page.locator('#navigation a[data-page]').evaluateAll(links=>links.map(a=>({id:a.dataset.page,label:a.textContent.trim()})));
 for(const {id,label} of sidebarLinks){
  await page.goto(url+'#'+id);
  await expect(page.locator('article h1')).toHaveText(label);
  await expect(page.locator(`#navigation a[data-page="${id}"]`)).toHaveAttribute('aria-current','page');
 }
 await page.goto(url+'#deployment-topic-9');
 await expect(page.locator('#deployment-topic-9')).toBeVisible();
 await expect(page.locator('#breadcrumb')).toContainText('无 systemd 的容器');
 await page.goto(url+'#gateway');
 await expect(page.locator('.network-route')).toBeVisible();
 await expect(page.locator('.network-route')).toContainText('管理员电脑');
 await page.goto(url+'#case-egress-mixed');
 await expect(page.locator('article h1')).toHaveText('成员 A 直连，成员 B 通过管理端访问模型');
 for(const scenario of ['example','case-new-member','case-egress-mixed']){
  await page.goto(url+'#'+scenario);
  await expect(page.locator('.case-diagram')).toBeVisible();
  await expect(page.locator('.table-scroll.cols-2')).toBeVisible();
 }
 await page.setViewportSize({width:390,height:844});await page.goto(url+'#start');
 await page.getByRole('button',{name:'目录',exact:true}).click();await expect(page.locator('#sidebar')).toBeVisible();
 await page.locator('#sidebar').getByRole('link',{name:'文件传输和轨迹上传',exact:true}).click();await expect(page.locator('#sidebar')).not.toBeVisible();
 await expect(page.locator('article h1')).toHaveText('文件传输和轨迹上传');
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);expect(overflow).toBe(false);
 await page.screenshot({path:path.join(output,'mobile.png'),fullPage:false});
 await page.goto(url+'#roles');
 await expect(page.locator('.table-scroll').first()).toBeVisible();
 await page.screenshot({path:path.join(output,'mobile-table.png'),fullPage:false});
 const tableLayout=await page.locator('.table-scroll').first().evaluate(el=>({scrolls:el.scrollWidth>el.clientWidth,documentOverflows:document.documentElement.scrollWidth>innerWidth+1}));
 expect(tableLayout).toEqual({scrolls:true,documentOverflows:false});
 expect(errors).toEqual([]);expect(requests).toEqual([]);
 const report={passed:true,offline:true,topicsAndSectionsChecked:targets.length,consoleErrors:errors,networkRequests:requests,screenshots:output};
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
