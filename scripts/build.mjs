import { build } from 'esbuild';
import { mkdir, mkdtemp, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const checkOnly = process.argv.includes('--check');
const outputRoot = checkOnly ? await mkdtemp(path.join(os.tmpdir(), 'workbench-build-check-')) : 'dist';
async function copyDependency(name, dest, sourceRequire = require, seen = new Set()) {
  if (seen.has(name)) return; seen.add(name);
  const jsonPath = sourceRequire.resolve(name + '/package.json'), dir = path.dirname(jsonPath), pkg = JSON.parse(await readFile(jsonPath, 'utf8'));
  await cp(dir, path.join(dest, 'node_modules', name), { recursive: true });
  for (const dependency of Object.keys(pkg.dependencies || {})) await copyDependency(dependency, dest, createRequire(jsonPath), seen);
}
for (const edition of ['user', 'admin']) {
  const out = path.join(outputRoot, edition); await mkdir(out, { recursive: true });
  await build({ entryPoints: [edition === 'user' ? 'src/main/index.ts' : 'src/admin/main.ts'], outfile: out + '/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'ssh2'], sourcemap: false });
  await build({ entryPoints: [edition === 'user' ? 'src/main/preload.ts' : 'src/admin/preload.ts'], outfile: out + '/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
  await build({ entryPoints: [edition === 'user' ? 'src/renderer/main.tsx' : 'src/admin/renderer.tsx'], outfile: out + '/renderer.js', bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'chrome130', loader: { '.css': 'css' } });
  await copyFile('src/renderer/index.html', out + '/index.html');
  if (edition === 'admin') { await copyFile('server/acl_support.py', out + '/acl_support.py'); await copyFile('server/admin.py', out + '/admin.py'); await copyFile('server/content.py', out + '/content.py'); }
  await copyDependency('ssh2', out);
  await writeFile(out + '/package.json', JSON.stringify({ name: 'team-agent-' + edition, version, description: 'Team Agent ' + edition, author: 'Team Agent Workbench', main: 'main.cjs', dependencies: { ssh2: '^1.17.0' } }, null, 2));
}
console.log(checkOnly ? `Build verified in ${outputRoot}; running application files were not changed.` : 'Built isolated User and Admin applications.');
