import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const dir = path.resolve('docs/error-audit'), data = JSON.parse(await fs.readFile(path.join(dir,'report-data.json'),'utf8'));
assert.equal(data.summary.pendingCandidates,0,'Every baseline candidate needs a recorded disposition');
assert.equal(new Set(data.candidates.map(r=>r.id)).size,data.candidates.length,'Duplicate candidate IDs');
assert.equal(new Set(data.scenes.map(r=>r.id)).size,data.scenes.length,'Duplicate scenario IDs');
const issues=[];
if(data.coveragePending?.length)issues.push('Additional discovered scenes pending: '+data.coveragePending.join('；'));
if(data.summary.pendingFollowup!==0)issues.push('Source follow-up is incomplete: '+data.summary.pendingFollowup);
for(const scene of data.scenes){
  if(!scene.changeReason)issues.push(scene.id+': missing reason for change');
  for(const phase of ['before','after','originalBaseline']){const p=scene[phase].screenshot;if(!p){issues.push(scene.id+': '+phase+' missing');continue;} const file=path.resolve(dir,p);assert(file.startsWith(dir+path.sep),'Screenshot outside report');const bytes=await fs.readFile(file);assert(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'||bytes.subarray(0,3).toString('hex')==='ffd8ff','Not a supported actual screenshot: '+p);assert.equal(createHash('sha256').update(bytes).digest('hex'),scene[phase].sha256,'Screenshot changed: '+p);}
  if(!scene.pass)issues.push(scene.id+': scenario assertions incomplete');
  if(!scene.notApplicable && !(scene.review?.score >= 9))issues.push(scene.id+': readability below 9/10 or not scored');
  if(scene.notApplicable && !(scene.review?.score === null && scene.review?.errorReadability === 'not_applicable'))issues.push(scene.id+': invalid readability exemption');
  if(scene.review?.pass!==true)issues.push(scene.id+': independent UI review not passed');
  if(!scene.review?.factualVerification || scene.review.factualVerification === 'pending_author_evidence')issues.push(scene.id+': factual verification missing');
  if(scene.review?.afterSha256!==scene.after.sha256)issues.push(scene.id+': reviewed screenshot hash stale or missing');
  for(const extra of scene.review?.additionalEvidence || []) {
    const file=path.resolve(dir,extra.evidence.startsWith('screenshots/') ? extra.evidence : 'screenshots/' + extra.evidence);
    assert(file.startsWith(dir+path.sep),'Additional screenshot outside report');
    assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),extra.afterSha256,'Additional reviewed screenshot changed: '+extra.evidence);
    if(!(extra.score>=9) || extra.pass!==true)issues.push(scene.id+': additional evidence below 9/10 or not factually verified: '+extra.evidence);
    if(!extra.factualVerification || extra.factualVerification==='pending_author_evidence')issues.push(scene.id+': additional evidence lacks factual verification: '+extra.evidence);
  }
}
if(issues.length){console.error(issues.join('\n'));process.exitCode=1;}else console.log(JSON.stringify({passed:true,scenarios:data.scenes.length,scored:data.summary.scored,minimumScore:data.summary.minimumScore,notApplicable:data.summary.notApplicable,screenshots:data.scenes.length*2,reviewedCandidates:data.candidates.length}));
