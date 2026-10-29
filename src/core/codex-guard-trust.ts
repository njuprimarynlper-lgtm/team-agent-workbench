import fs from 'node:fs/promises';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { guardNetworkCode, guardNetworkMarker, guardNetworkMessage, type GuardNetworkProblem, type GuardNetworkStage } from '../shared/guard-network';

/** Never retain a raw error/cause: TLS and proxy messages may contain credentials or certificate data. */
export class GuardNetworkError extends Error {
  readonly problem: GuardNetworkProblem;
  constructor(stage: GuardNetworkStage, code: unknown, viaProxy = false) {
    const problem = { stage, code: guardNetworkCode(code), viaProxy };
    super(guardNetworkMessage(problem) + ' 未切换网络通路。' + guardNetworkMarker(problem));
    this.name = 'GuardNetworkError'; this.problem = problem;
  }
}
export function guardNetworkError(error: unknown, stage: GuardNetworkStage, viaProxy: boolean) {
  return error instanceof GuardNetworkError ? error : new GuardNetworkError(stage, (error as NodeJS.ErrnoException)?.code, viaProxy);
}
type ReadRoots = (type: 'default' | 'system') => string[];
/** Explicit per-connection roots; never alter the process-wide or Windows trust store. */
export async function guardTrustedCertificates(env: NodeJS.ProcessEnv, certificateFile = '', readRoots?: ReadRoots): Promise<string[]> {
  let roots: string[];
  try {
    const read = readRoots || (typeof tls.getCACertificates === 'function' ? tls.getCACertificates : undefined);
    if (!read) throw Error();
    roots = [...read('default'), ...read('system')];
  } catch { throw new GuardNetworkError('certificate', 'SYSTEM_CA_UNAVAILABLE'); }
  // Codex's explicit bundle overrides SSL_CERT_FILE. Workbench and Node additions remain additive.
  const files = new Set([certificateFile, env.CODEX_CA_CERTIFICATE || env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS].filter((file): file is string => !!file?.trim()));
  for (const file of files) {
    let data: Buffer;
    try {
      const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error();
      data = await fs.readFile(file);
    } catch { throw new GuardNetworkError('certificate', 'CA_FILE_UNREADABLE'); }
    try {
      const source = data.toString('utf8');
      if (/PRIVATE KEY/.test(source)) throw Error();
      const blocks = source.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      // PEM bundles may include comments or OpenSSL bag attributes between certificates.
      const remainder = source.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '');
      if (/-----BEGIN|-----END/.test(remainder)) throw Error();
      for (const block of blocks || [data]) {
        const cert = new X509Certificate(block);
        if (!cert.ca) throw Error();
        roots.push(cert.toString());
      }
    } catch { throw new GuardNetworkError('certificate', 'CA_FILE_INVALID'); }
  }
  return [...new Set(roots)];
}
