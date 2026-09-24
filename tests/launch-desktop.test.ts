import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
// @ts-expect-error JavaScript launcher also runs before the TypeScript build.
import { launchDesktop } from '../scripts/launch-desktop.mjs';

test('desktop launch detaches the application and console handles, preserving exact paths and parent environment', async () => {
  const root = path.resolve('fixture space & 中文'), previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    for (const edition of ['user', 'admin']) {
      let unreferenced = false;
      const child = Object.assign(new EventEmitter(), { pid: 42, unref() { unreferenced = true; } });
      const result = launchDesktop(root, edition, (file: string, args: string[], options: any) => {
        assert.equal(file, path.join(root, 'node_modules/electron/dist/electron.exe'));
        assert.deepEqual(args, [path.join(root, 'dist', edition)]);
        assert.equal(options.cwd, root); assert.equal(options.shell, false);
        assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore');
        assert.equal(options.windowsHide, false, 'the application window must be visible; detached + ignored stdio release the terminal');
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
        assert.notEqual(options.env, process.env);
        queueMicrotask(() => child.emit('spawn'));
        return child;
      });
      assert.equal(unreferenced, false, 'startup must wait for the spawn acknowledgement');
      assert.equal(await result, 42); assert.equal(unreferenced, true);
    }
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
  } finally { if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous; }
});

test('desktop spawn failure is reported and invalid editions never start a process', async () => {
  const child = Object.assign(new EventEmitter(), { unref() { assert.fail('failed launch cannot detach'); } });
  await assert.rejects(launchDesktop(process.cwd(), 'user', () => {
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT'))); return child;
  }), /ENOENT/);
  await assert.rejects(launchDesktop(process.cwd(), '../other', () => assert.fail('invalid edition spawned')), /Unknown workbench edition/);
});
