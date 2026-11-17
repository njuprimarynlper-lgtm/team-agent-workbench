/** Exhaustive display-site inventory for this audit's assigned components. */
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const adminFiles = (await fs.readdir(path.join(root, 'src/admin'))).filter(name => name.endsWith('.tsx')).map(name => 'src/admin/' + name);
const userFiles = ['shared-content','shared-content-delete','assignments','assignment-lifecycle','team-questions','transfer-records','project-interactions','activity-recommendations','activity-result-actions','attachments','project-results','result-card','result-lifecycle','conclusions','draft-list','content-updates'].map(name => 'src/renderer/' + name + '.tsx');
const remainingNames = new Set(['scheduled-tasks','draft-editor','content-updates','subsessions','personal-workspace','team-groups','result-directories','project-brief-editor','directions','draft-delete','account-sync','project-onboarding','beta-features','rsi-project-settings','rsi-recommendation-toggle','central-node-menu','context-menu','copy-text-button','draft-list','sidebar-project-item','result-category-filter','egress-route','font-size-shortcuts','team-cache','autosave','project-refresh']);
const belongsToRemaining = file => { const name=path.basename(file).replace(/\.tsx?$/,''); return file.startsWith('src/renderer/') && (remainingNames.has(name)||/^(?:preparation-|mermaid|markdown)/.test(name)); };
const globalInventory=JSON.parse(await fs.readFile(path.join(root,'docs/error-audit/inventory.json'),'utf8'));
const files = [...new Set([...adminFiles, ...userFiles, ...globalInventory.sourceFiles.filter(source=>belongsToRemaining(source.file)).map(source=>source.file)])];
const inventory = [];
for (const file of files) {
  const text = await fs.readFile(path.join(root, file), 'utf8');
  const sites = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((snippet,index) => {
    const setter = /set(?:Error|Failure|UpgradeError|RefreshWarning|ScanNotice)\(/.test(snippet) && !/^\s*(?:const \[|import)/.test(snippet);
    const disabled = /\b(?:disabled|title)=/.test(snippet);
    const rendered = /\{[^{}]*(?:error|failure|warning|lastError|setupIssues|missingCommands|\.detail\b|blocked|unavailable)[^{}]*\}/i.test(snippet);
    if (!setter && !disabled && !rendered) return;
    const kind = disabled ? 'disabled-or-tooltip' : setter ? 'failure-state-write' : 'rendered-status';
    const boundary = /uiErrorMessage|adminErrorMessage|transferRecordError/.test(snippet) ? 'normalized-at-site'
      : /uiErrorMessage|adminErrorMessage/.test(text) && /\b(?:error|failure|refreshWarning|upgradeError)\b/.test(snippet) ? 'normalized-before-state-or-parent'
        : disabled ? 'business-condition' : 'business-status-or-parent-provided';
    sites.push({ id: file.replace(/[^a-zA-Z0-9]/g,'-') + '-' + (index+1), line: index+1, kind, source: snippet.trim(), boundary, disposition: 'inventoried', assertion: 'Review the complete source line and mapper/parent boundary; one line may contain several JSX controls.' });
  });
  inventory.push({ file, sites, count: sites.length, inventoryComplete: true, reviewMethod: 'Line-pattern source inventory. Semantic classifications are in admin-review.json; this flag does not mean every control was manually exercised.' });
}
const scenarios=JSON.parse(await fs.readFile(path.join(root,'docs/error-audit/admin-scenarios.json'),'utf8')).scenarios;
const result = { version: 1, scope: 'All matching display lines in src/admin TSX and all assigned renderer components, including the expanded remaining-component scope; excludes other agents\' session/network/directory components and main/preload.', files: inventory, counts: { files: inventory.length, displayLines: inventory.reduce((sum,file)=>sum+file.count,0) }, screenshotScenarios: 'admin-scenarios.json', verification: scenarios.length + ' production-component failure families with before/after captures; this inventory records every matching display line in scope, including unchanged business rules and parent-provided state. It does not claim one screenshot per source line.' };
await fs.mkdir(path.join(root,'docs/error-audit'),{recursive:true});
await fs.writeFile(path.join(root,'docs/error-audit/admin-display-inventory.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.counts));
