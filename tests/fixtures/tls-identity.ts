import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

// Ephemeral, self-signed X.509 identity for loopback tests. No OS certificate
// store, shell, desktop process, fixed private key or additional dependency.
export function testTlsIdentity() {
  const der = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts), length = body.length;
    const size = length < 128 ? Buffer.from([length]) : length < 256 ? Buffer.from([0x81, length]) : Buffer.from([0x82, length >> 8, length & 255]);
    return Buffer.concat([Buffer.from([tag]), size, body]);
  };
  const seq = (...parts: Buffer[]) => der(0x30, ...parts);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(der(6, Buffer.from('2a864886f70d01010b', 'hex')), der(5));
  const name = seq(der(0x31, seq(der(6, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from('workbench-loopback-test')))));
  const tbs = seq(der(2, Buffer.from([1])), algorithm, name,
    seq(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('491231235959Z'))), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const certificate = seq(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: new X509Certificate(certificate).toString(), fingerprint: new X509Certificate(certificate).fingerprint256 };
}
