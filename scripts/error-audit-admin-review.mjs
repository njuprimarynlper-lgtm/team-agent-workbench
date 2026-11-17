import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const inventory = JSON.parse(await fs.readFile(path.join(root,'docs/error-audit/inventory.json'),'utf8'));
const screenshots = JSON.parse(await fs.readFile(path.join(root,'docs/error-audit/admin-scenarios.json'),'utf8')).scenarios;
const remainingNames = new Set(['scheduled-tasks','draft-editor','content-updates','subsessions','personal-workspace','team-groups','result-directories','project-brief-editor','directions','draft-delete','account-sync','project-onboarding','beta-features','rsi-project-settings','rsi-recommendation-toggle','central-node-menu','context-menu','copy-text-button','draft-list','sidebar-project-item','result-category-filter','egress-route','font-size-shortcuts','team-cache','autosave','project-refresh']);
const belongsToRemaining = file => { const name=path.basename(file).replace(/\.tsx?$/,''); return file.startsWith('src/renderer/') && (remainingNames.has(name)||/^(?:preparation-|mermaid|markdown)/.test(name)); };
const rendererFiles = new Set(['shared-content','shared-content-delete','assignments','assignment-lifecycle','team-questions','transfer-records','project-interactions','activity-recommendations','activity-result-actions','attachments','project-results','result-card','result-lifecycle','conclusions','draft-list','content-updates'].map(name=>'src/renderer/'+name+'.tsx'));
for (const source of inventory.sourceFiles) if (belongsToRemaining(source.file)) rendererFiles.add(source.file);
const coreFiles = new Set(['src/core/transfers.ts','src/core/rsi.ts','src/core/activity-assistant.ts','src/core/account-sync.ts']);
const entries = inventory.entries.filter(entry => entry.file.startsWith('src/admin/') && !['src/admin/main.ts','src/admin/preload.ts'].includes(entry.file) || rendererFiles.has(entry.file) || coreFiles.has(entry.file));
const current = new Map();
for (const file of new Set(entries.map(entry=>entry.file))) current.set(file,await fs.readFile(path.join(root,file),'utf8'));
const rules = {
 'RENDER_FALLBACK': 'Formatting/diagram/image/URL parsing errors use an explicit unsupported/source/text fallback. These candidates are rendering/data-validation branches, not a claim that an external operation succeeded.',
 'OPTIONAL_PREFERENCE': 'Font-size storage failure retains the current in-memory setting; it does not block work or claim the preference was persisted.',
 'AUTOSAVE_QUEUE': 'Autosave retains the latest edit outside mounted views, reports failure and provides retry/flush. Promise catches keep the serial queue alive; they do not mark a failed save complete. Current save callbacks call the normalized workbench IPC.',
 'CACHE_FALLBACK': 'Failure to read optional local cache falls through to a fresh read; access revocation clears cached data and fresh-read failures propagate to the caller.',
 'DISPLAY_BOUNDARY': 'Exceptions shown by the assigned React components pass uiErrorMessage/adminErrorMessage, collaborationFailure/taskFailure or transferRecordError. Cached error strings receive the same translation at render. This rule proves the technical-detail boundary, not that every backend string was manually copyedited.',
 'UI_BUSINESS_CONDITION': 'Existing disabled/loading/empty state expressions are retained unless covered by a named state correction. Their conditions remain explicit source evidence; the rule does not infer clarity merely from the presence of Chinese.',
 'BACKEND_BOUNDARY': 'Backend exceptions and persisted error fields reach src/admin/main.ts/publicErrorState/publicFailure or the user workbench IPC mapper before presentation. Technical exceptions remain diagnostic logs; source guards and operation receipts remain authoritative.',
 'TRANSFER_RECEIPT': 'Transfer errors are recorded to diagnostic logs and translated with the actual phase. Awaiting receipts stay uncertain and retry queries the original receipt; file-system errors do not infer which endpoint failed. A verified receipt remains completed if subsequent local persistence fails; recovered persistence clears the warning. Missing upload cache does not prove a missing remote submission.',
 'CLIPBOARD_FEEDBACK': 'The original text stays visible. Copy failure uses an adjacent readable retry message and never changes to copied until IPC succeeds; technical copy exceptions are recorded by the central IPC boundary.',
 'PROJECT_REFRESH_ACCESS': 'The actual project refresh button is disabled while busy or disconnected; its title identifies waiting for refresh or the real top-bar central-node login entry. No empty-list claim is made by this button.',
 'BACKGROUND_STATUS': 'Recommendation failures stay inline as status, with an independent last-failure message or expandable reason. They do not open dialogs or block conversation.',
 'EXPECTED_FALLBACK': 'The catch has a specified non-fatal fallback: missing optional metadata, absent capacity support, canceled/stale work, serialization queue recovery, tray/notification fallback, or cleanup. It is not silently converted to successful business completion.',
};
const manualChanges = [
 ['src/renderer/team-questions.tsx',44,'team-question-feed-read-failure','QuestionFeed provides its own actual sync retry and keeps prior items when reading fails; an unread list is never declared empty.'],
 ['src/renderer/team-questions.tsx',45,'team-question-feed-read-failure','The no-questions state requires a successful list state; the full main fixture verifies recovery and retained prior records after another failure.'],
 ['src/core/account-sync.ts',208,'team-account-sync-cache-unreadable','An unreadable local account-sync cache exits activation before polling starts. The separate UI reports sync not started, retains local data and links the actual account.sync.cache_unreadable diagnostic.'],
 ['src/renderer/scheduled-tasks.tsx',42,'team-scheduled-read-failure','Initial read failure is an unknown list, not no tasks; a successful refresh clears the separate read error.'],
 ['src/renderer/scheduled-tasks.tsx',62,'team-scheduled-read-failure','No empty-task declaration or zero confirmed-history count after a failed initial read.'],
 ['src/renderer/rsi-project-settings.tsx',16,'team-rsi-settings-read-failure','Snapshot read failure is surfaced with retry instead of permanent loading.'],
 ['src/renderer/directions.tsx',50,'team-directions-read-failure','Unread member cards are not treated as empty editable cards.'],
 ['src/renderer/account-sync.tsx',38,'team-account-sync-failure','Sync detail is normalized, local work continues, and an old server is not assumed.'],
 ['src/core/account-sync.ts',331,'team-account-sync-failure','Technical sync errors are logged; public detail does not diagnose an unsupported server without evidence.'],
 ['src/renderer/team-groups.tsx',85,'admin-projects-read-failure','Failed project-list reads do not display no projects.'],
 ['src/renderer/project-brief-editor.tsx',37,'team-project-brief-read-failure','Unread project brief is not shown as unfilled; editing requires a successful read.'],
 ['src/renderer/personal-workspace.tsx',39,'team-personal-group-refresh-failure','Confirmed group save closes the create form before refresh; failure cannot encourage duplicate creation.'],
 ['src/renderer/result-directories.tsx',51,'team-results-move-uncertain','Only acknowledged moved items are counted; later group results stay unconfirmed after transport failure.'],
 ['src/renderer/draft-delete.tsx',25,'team-draft-delete-partial','Per-item message fields are normalized while confirmed deletion counts and retry scope are retained.'],
 ['src/renderer/conclusions.tsx',228,'team-personal-read-failure','Failed initial personal-library read does not claim no results exist.'],
 ['src/renderer/draft-list.tsx',75,'team-draft-upload-unconfirmed','A transfer ID alone is described as a retained upload record, not a saved independent result.'],
 ['src/renderer/content-updates.tsx',58,'team-updates-refresh-failure','Confirmed state changes remain confirmed when the subsequent list refresh fails.'],
 ['src/admin/connection.ts',75,'admin-ssh-check-timeout','Timeout no longer diagnoses missing root/sudo permissions.'],
 ['src/admin/people.tsx',30,'admin-member-blocked','Creator and member readiness blockers now have visible explanations.'],
 ['src/admin/renderer.tsx',64,'admin-recovery','Recovery title names the operation/object and separates failure from remaining steps.'],
 ['src/admin/storage-view.tsx',63,'admin-storage-partial','Incomplete totals are labelled as measured occupancy, with possible undercount.'],
 ['src/admin/storage-view.tsx',35,'admin-storage-cancelled','User cancellation is a status, not an error alert.'],
 ['src/renderer/shared-content.tsx',65,'team-results-personal-read','Team/history/personal read failures are attributed separately and background failures use status.'],
 ['src/renderer/shared-content.tsx',276,'team-results-merge-blocked','Disabled merge choices explain source availability, linked tasks or category conflict.'],
 ['src/renderer/assignments.tsx',78,'team-tasks-read','Failed initial read does not claim that no tasks exist.'],
 ['src/renderer/team-questions.tsx',188,'team-question-auto-blocked','Auto-dialogue blockers identify the actual required work session or running task.'],
 ['src/renderer/team-questions.tsx',197,'team-question-stopping','Stopping remains pending until server confirmation.'],
 ['src/renderer/transfer-records.tsx',25,'team-transfer-cache','Missing cache disables retransmission but does not prove the server missed the original content. The visible next step is to check remote content or the original receipt before submitting again.'],
 ['src/renderer/project-interactions.tsx',69,'team-rsi-retry','Queued retry no longer hides the last analysis error.'],
 ['src/renderer/activity-recommendations.tsx',79,'team-activity-failed','Stored failure reasons are available without interrupting conversation.'],
 ['src/admin/project-purge.ts',16,'admin-project-catalog-unreadable','Unreadable group directories no longer become an empty cleanup catalog; diagnostic details are retained and the UI provides a reread action.'],
 ['src/admin/project-purge.ts',23,'admin-project-catalog-unreadable','Only absent registration files are skipped. Unreadable or invalid existing project registration makes the catalog unknown.'],
 ['src/admin/project-purge.ts',51,'admin-project-index-unreadable','An unreadable existing result index stops keep-trajectories cleanup before any file deletion; a missing optional index still means no entries.'],
 ['src/admin/storage-view.tsx',112,'admin-project-catalog-unreadable','Project-catalog read failure is separate from an empty catalog, and cleanup remains unavailable until a complete read.'],
 ['src/renderer/project-onboarding.tsx',27,'team-project-created-refresh-failure','A project already confirmed on the central node is retained across parent refresh failure. Retry only refreshes; initialization is not repeated.'],
 ['src/renderer/draft-editor.tsx',121,'team-draft-transfer-cache','A missing upload cache blocks retransmission and preserves the unknown original receipt; creating a revision does not imply the previous upload failed.'],
 ['src/renderer/draft-editor.tsx',172,'team-draft-transfer-cache','The same transfer mapping and cache restriction also apply to team publication after personal merge.'],
 ['src/renderer/preparation-review.tsx',54,'team-draft-transfer-cache','Per-artifact upload states retain unknown receipts instead of claiming definitive upload failure.'],
 ['src/renderer/preparation-review.tsx',55,'team-draft-transfer-cache','The actual per-artifact review pane maps persisted transfer errors and disables retransmission when the original upload cache is absent.'],
];
const reviewed = entries.map(entry=>{
 const source = current.get(entry.file), isRenderer=entry.file.endsWith('.tsx');
 let rule = isRenderer ? entry.kind==='ui-state'?'UI_BUSINESS_CONDITION':'DISPLAY_BOUNDARY' : entry.kind==='silent-catch'?'EXPECTED_FALLBACK':'BACKEND_BOUNDARY';
 if(entry.file==='src/core/transfers.ts')rule='TRANSFER_RECEIPT';
 if(['src/renderer/project-interactions.tsx','src/renderer/activity-recommendations.tsx'].includes(entry.file) || ['src/core/rsi.ts','src/core/activity-assistant.ts'].includes(entry.file))rule='BACKGROUND_STATUS';
 if(/\/(?:mermaid|markdown)/.test(entry.file))rule='RENDER_FALLBACK';
 if(entry.file==='src/renderer/font-size-shortcuts.ts')rule='OPTIONAL_PREFERENCE';
 if(entry.file==='src/renderer/autosave.ts')rule='AUTOSAVE_QUEUE';
 if(entry.file==='src/renderer/team-cache.ts')rule='CACHE_FALLBACK';
 if(entry.file==='src/renderer/copy-text-button.tsx')rule='CLIPBOARD_FEEDBACK';
 if(entry.file==='src/renderer/project-refresh.tsx')rule='PROJECT_REFRESH_ACCESS';
 const change=manualChanges.find(([file,line])=>entry.file===file&&entry.line===line);
 const related=screenshots.filter(item=>item.file===entry.file);
 return { candidateId:entry.id,file:entry.file,baselineLine:entry.line,baselineSnippet:entry.snippet,kind:entry.kind,reviewType:'rule-based',rule,disposition:change?'changed-and-verified':isRenderer?'covered-display-or-business-condition':'covered-backend-or-expected-fallback',conclusion:change?change[3]:rules[rule],evidence:{currentMapper:isRenderer?/adminErrorMessage/.test(source)?'src/admin/failure.ts':/transferRecordError/.test(source)?'src/shared/transfer-failure.ts':/uiErrorMessage/.test(source)?'src/shared/user-failure.ts':'parent-provided error/status and literal business conditions':entry.file==='src/core/transfers.ts'?'src/shared/transfer-failure.ts':'src/main/public-failures.ts',scenarioIds:change?[change[2]]:related.map(item=>item.id),screenshotCoverage:change?'named-trigger':related.length?'same-component-failure-family':'boundary-regression-or-source-route',sourceReview:'Source conditions and routing reviewed; candidate classification applied by rule, not individually marked as human reviewed.',candidateSpecificBrowserExercise:!!change,sameFileBrowserScenarios:related.length,allRelatedScenariosPass:related.length?related.every(item=>item.pass):null} };
});
const result={version:1,readabilityRound:2,independentReadability:'docs/error-audit/readability-review.json (functional pass is not a readability score)',baseline:inventory.baseline,scope:{admin:'src/admin except main/preload (root agent)',renderer:[...rendererFiles],core:[...coreFiles]},method:'Rules applied to every selected global candidate ID. Named state corrections were inspected directly. Non-named candidates are rule-based boundary/condition review, not blanket manual copy approval.',rules,counts:{candidates:reviewed.length,ruleBased:reviewed.length,namedCorrections:reviewed.filter(item=>item.disposition==='changed-and-verified').length,unclassified:0},entries:reviewed,validation:{screenshots:'admin-scenarios.json',displayInventory:'admin-display-inventory.json',unitTests:'tests/error-audit-admin.test.ts',backgroundPrinciple:'Inline status only for automatic failures; preserve foreground draft and work. Never mark an uncertain operation complete or recommend duplicating it.'}};
await fs.writeFile(path.join(root,'docs/error-audit/admin-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.counts));
