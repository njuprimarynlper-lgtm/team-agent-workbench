import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedSessionFile, listSessionFiles, previewSessionFile, sessionFilePath } from '../src/core/session-files';
import type { AgentSession } from '../src/shared/types';

test('session output files resolve Markdown links, paths with spaces, line numbers and legacy file changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-files-'));
  try {
    const report = path.join(root, '验证 报告.md'), source = path.join(root, 'solution.py');
    await fs.writeFile(report, '# 验证结果\n\n文件可以直接打开。'); await fs.writeFile(source, 'print("ok")');
    const session = { cwd: root, outputFiles: ['solution.py'], messages: [
      { role: 'assistant', text: `[验证报告](<${report.replaceAll('\\', '/')}:12>)\n[同一报告](${pathToFileURL(report).href})\n[网页](https://example.com/a.pdf)` },
      { role: 'tool', text: JSON.stringify({ type: 'fileChange', changes: [{ path: source }] }) }
    ] } as unknown as AgentSession;
    assert.equal(sessionFilePath(session, 'solution.py#L3'), source);
    const files = await listSessionFiles(session); assert.equal(files.length, 2); assert(files.some(file => file.path === report));
    const preview = await previewSessionFile(session, pathToFileURL(report).href); assert.equal(preview.type, 'text'); assert.match(preview.content, /直接打开/); assert.equal(preview.path, report);
    await assert.rejects(checkedSessionFile(session, path.join(os.tmpdir(), 'unmentioned.txt')), /不属于/);
    await assert.rejects(previewSessionFile(session, 'missing.md'), /不存在或已移动/);
    for (const target of ['javascript:alert(1)', 'https://example.com/a', '\\\\server\\share\\file.md', 'file://server/share/file.md']) assert.throws(() => sessionFilePath(session, target));
    await fs.unlink(source); assert.equal((await listSessionFiles(session)).length, 1);
  } finally { assert(root.startsWith(path.join(os.tmpdir(), 'wb-files-'))); await fs.rm(root, { recursive: true, force: true }); }
});
