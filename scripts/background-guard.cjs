// Test-only guard: fail before any desktop/shell process can be created.
const childProcess = require('node:child_process');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

function assertBackgroundProcess(file, args = [], options = {}, ownedPids = new Set()) {
  const name = path.win32.basename(String(file)).toLowerCase().replace(/\.exe$/, '');
  if (options.shell || options.detached) throw new Error('后台测试禁止 Shell 或独立控制台进程');
  if (!['node', 'python', 'python3', 'git', 'taskkill'].includes(name)) throw new Error('后台测试禁止启动此程序：' + name);
  if (name === 'taskkill') {
    if (args.length !== 4 || args[0] !== '/PID' || args[2] !== '/T' || args[3] !== '/F' || !ownedPids.has(Number(args[1]))) throw new Error('后台测试只能结束自己创建的测试进程');
  }
  return { ...options, windowsHide: true, shell: false, detached: false };
}

if (process.env.WORKBENCH_BACKGROUND_TESTS === '1') {
  const ownedPids = new Set();
  // Intercept the shared async launch point, preserving execFile's promisify contract.
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (options) {
    const safeOptions = assertBackgroundProcess(options.file, options.args?.slice(1), options, ownedPids);
    const result = originalSpawn.call(this, safeOptions);
    if (this.pid) { ownedPids.add(this.pid); this.once('exit', () => ownedPids.delete(this.pid)); }
    return result;
  };
  for (const method of ['spawnSync', 'execFileSync']) {
    const original = childProcess[method];
    childProcess[method] = function (file, args, options) {
      if (!Array.isArray(args)) { options = args; args = []; }
      const safeOptions = assertBackgroundProcess(file, args, options, ownedPids);
      return original.call(this, file, args, safeOptions);
    };
  }
  for (const method of ['exec', 'execSync']) childProcess[method] = () => { throw new Error('后台测试禁止执行 Shell 命令'); };
  syncBuiltinESMExports();
}

module.exports = { assertBackgroundProcess };
