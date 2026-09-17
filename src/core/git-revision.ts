import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitRevision } from '../shared/content';
const run = promisify(execFile);
export async function gitRevision(cwd: string): Promise<GitRevision | undefined> {
  const git = async (...args: string[]) => (await run('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  try {
    const [commit, branch, status] = await Promise.all([git('rev-parse', 'HEAD').catch(() => ''), git('symbolic-ref', '--short', '-q', 'HEAD').catch(() => 'detached'), git('status', '--porcelain', '--untracked-files=normal')]);
    return { commit: /^[a-f0-9]{40,64}$/.test(commit) ? commit : undefined, branch, dirty: !!status, capturedAt: new Date().toISOString() };
  } catch { return undefined; }
}
