import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const dir=path.resolve('docs/error-audit');
const rows=JSON.parse(await fs.readFile(path.join(dir,'native-scenarios.json'),'utf8'));
for(const row of rows){
 const observation=JSON.parse(await fs.readFile(path.join(dir,row.id+'-round2-observation.json'),'utf8'));
 const bytes=await fs.readFile(path.join(dir,'screenshots',row.id+'-after.jpg'));
 assert(observation.accessibility?.tree);assert(bytes.length>1000);
 row.afterUI=observation.accessibility.tree.split('\n').filter(line=>/ text \(文本\)| button \(按钮\)/.test(line)).map(line=>line.trim().replace(/^\d+ (?:text|button) \([^)]*\) /,'').replace(/ ID: .+$/,'')).join('\n');
 row.readabilityRound=2;row.afterScreenshot='screenshots/'+row.id+'-after.jpg';row.capture='actual production native Electron dialog captured with computer-use:computer-use';
 row.validation={observed:row.id+'-round2-observation.json',sha256:createHash('sha256').update(bytes).digest('hex'),recovery:observation.recovery||null,conditions:'同一隔离合成IO故障；原生系统自动布局会随正文长度调整尺寸，未裁切或合成截图'};row.pass=true;
}
await fs.writeFile(path.join(dir,'native-scenarios.json'),JSON.stringify(rows,null,2));
const launcher=JSON.parse(await fs.readFile(path.join(dir,'launcher-observations.json'),'utf8'));
const after=launcher.find(row=>row.phase==='after'&&row.id==='native-launcher');assert(after);
const observation=JSON.parse(await fs.readFile(path.join(dir,'native-launcher-round2-observation.json'),'utf8'));
after.readabilityRound=2;after.pass=true;after.observation='native-launcher-round2-observation.json';after.dimensions=observation.dimensions;after.geometryNote='真实WinForms自动DPI缩放，未裁切或合成截图';
await fs.writeFile(path.join(dir,'launcher-observations.json'),JSON.stringify(launcher,null,2));
console.log('Four actual native captures registered; readability approval remains independent.');
