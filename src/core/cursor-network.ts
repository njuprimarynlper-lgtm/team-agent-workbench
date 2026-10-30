import path from 'node:path';

export function cursorNetworkPreload(directory = __dirname) {
  // Cursor runs in ordinary Node, which cannot read Electron's ASAR filesystem.
  return path.join(directory, 'cursor-network.cjs').replace(/([\\/]app\.asar)(?=[\\/])/i, '$1.unpacked');
}

/** Only Workbench-managed Cursor children receive the additional Windows trust. */
export function cursorNetworkEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.TEAM_AGENT_MANAGEMENT_PROXY !== '1') return env;
  const preload = cursorNetworkPreload();
  const existing = env.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? '';
  return { ...env, NODE_OPTIONS: existing.includes(JSON.stringify(preload)) ? existing : `${existing} --require ${JSON.stringify(preload)}`.trim() };
}
