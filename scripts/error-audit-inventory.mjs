import fs from 'node:fs/promises';
import path from 'node:path';
import installedTypeScript from 'typescript';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root = process.cwd(), base = path.join(root, '.test-data/error-audit/baseline');
// TypeScript 7's native package omits the compiler AST API. Audit tooling uses
// an isolated TS 5 compiler, never changing application dependencies.
const ts = installedTypeScript.createSourceFile ? installedTypeScript : createRequire(import.meta.url)(process.env.ERROR_AUDIT_TYPESCRIPT || path.join(root, '.test-data/error-audit/ast-tools/node_modules/typescript'));
const output = path.join(root, 'docs/error-audit'); await fs.mkdir(output, { recursive: true });
async function files(directory) { return (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(item => item.isDirectory() ? files(path.join(directory, item.name)) : path.join(directory, item.name)))).flat(); }
const entries = [], sourceFiles = [];
for (const file of await files(path.join(base, 'src'))) {
  if (!/\.(?:ts|tsx|cjs)$/.test(file)) continue;
  const text = await fs.readFile(file, 'utf8'), relative = path.relative(base, file).replaceAll('\\', '/');
  sourceFiles.push({ file: relative, sha256: createHash('sha256').update(text).digest('hex') });
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, relative.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (node, kind) => { const location = source.getLineAndCharacterOfPosition(node.getStart()), line = location.line + 1, snippet = node.getText(source).slice(0, 800); entries.push({ id: createHash('sha256').update(relative + ':' + line + ':' + kind + ':' + snippet).digest('hex').slice(0, 14), file: relative, line, column: location.character + 1, kind, snippet, disposition: 'unreviewed' }); };
  const walk = node => {
    if (ts.isThrowStatement(node)) add(node, 'throw');
    else if (ts.isCatchClause(node)) add(node, node.block.statements.length ? 'catch' : 'silent-catch');
    else if (ts.isCallExpression(node) && /(?:^|\.)(?:setError|setStatus|setNotice|notice|showErrorBox|showMessageBox|reject)$/.test(node.expression.getText(source))) add(node, 'error-sink');
    else if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && /(?:inline-error|role=['"]alert|disabled=|ErrorNotice|ConnectionError|\.error\b)/.test(node.getText(source))) {
      if (ts.isJsxElement(node) && /^(?:div|p|span|button|section|input|select|textarea|fieldset|details|summary)\b/.test(node.openingElement.tagName.getText(source))) add(node, 'ui-state');
      else if (ts.isJsxSelfClosingElement(node)) add(node, 'ui-state');
    }
    ts.forEachChild(node, walk);
  }; walk(source);
}
for (const directory of ['server', 'scripts']) for (const file of await files(path.join(base, directory))) {
  const relative = path.relative(base, file).replaceAll('\\', '/');
  if (!(/\.py$/.test(file) && directory === 'server') && !/scripts\/(?:start-dev-hidden|startup-process|startup-logs)\.ps1$/.test(relative)) continue;
  const text = await fs.readFile(file, 'utf8'); sourceFiles.push({ file: relative, sha256: createHash('sha256').update(text).digest('hex') });
  text.split(/\r?\n/).forEach((line, index) => { if (/\braise\b|\bexcept\b|MessageBox|\bthrow\b/.test(line)) entries.push({ id: createHash('sha256').update(relative + ':' + (index + 1) + ':' + line).digest('hex').slice(0, 14), file: relative, line: index + 1, kind: directory === 'server' ? 'server-exception' : 'startup-exception', snippet: line.trim(), disposition: 'unreviewed' }); });
}
// The same expression can occur twice on one compact source line. Keep both
// locations, but do not reuse an ID or pretend their shared audit was two
// independent manual reviews.
const occurrences = new Map();
for (const entry of entries) {
  const original = entry.id, occurrence = (occurrences.get(original) || 0) + 1;
  occurrences.set(original, occurrence);
  if (occurrence > 1) { entry.legacyCandidateId = original; entry.id = original + '-' + occurrence; }
}
const result = { baseline: 'd4d51bb30d23f03a883867054a893c547e558f9e', baselineVersion: '2.3.46', sourceFiles, entries, note: 'AST候选不是独立用户场景；每项仍需按传播路径审阅。server/启动脚本行级扫描另行标注。同一行相同表达式以列号区分；legacyCandidateId说明复用同源审计依据，不冒充第二次人工复审。' };
await fs.writeFile(path.join(output, 'inventory.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ files: sourceFiles.length, candidates: entries.length, kinds: Object.fromEntries([...new Set(entries.map(e => e.kind))].map(kind => [kind, entries.filter(e => e.kind === kind).length])) }));
