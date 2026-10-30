// Loaded before Cursor (also inherited by its Node workers). This changes only
// the child process's CA roots, never the OS store or certificate validation.
if (process.env.TEAM_AGENT_MANAGEMENT_PROXY === '1') {
  const tls = require('node:tls');
  if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
    try { tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]); }
    catch { process.stderr.write('[WB_CURSOR_SYSTEM_CA_UNAVAILABLE]\n'); }
  } else {
    // Older runtimes can still use their existing CA configuration. Do not
    // crash a usable CLI or silently disable certificate checks.
    process.stderr.write('[WB_CURSOR_SYSTEM_CA_UNAVAILABLE]\n');
  }
}
// Only the Workbench's ACP process uses this adapter, never spawned tools,
// workers, interactive Cursor windows or account/model probes.
if (process.env.TEAM_AGENT_CURSOR_REQUEST_GUARD === '1' && process.argv.includes('acp')) {
  delete process.env.TEAM_AGENT_CURSOR_REQUEST_GUARD;
  require('./cursor-request-guard.cjs').install();
}
