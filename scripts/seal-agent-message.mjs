import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';

// Encrypt a local pilot reply without printing or persisting its plaintext elsewhere.
const [publicKeyFile, sourceFile, targetFile] = process.argv.slice(2);
if (!publicKeyFile || !sourceFile || !targetFile) {
  throw new Error('Usage: node scripts/seal-agent-message.mjs <recipient-public.pem> <local-private.json> <reply.sealed.json>');
}
if (path.resolve(sourceFile) === path.resolve(targetFile)) throw new Error('Input and output must differ');
const plaintext = await fs.readFile(sourceFile);
if (plaintext.length > 1024 * 1024) throw new Error('Reply exceeds 1 MiB');
const reply = JSON.parse(plaintext.toString('utf8').replace(/^\uFEFF/, ''));
if (reply.taskId !== 'proxy-pilot-20260920' || reply.inReplyTo !== 'client-0001') throw new Error('Unexpected task or reply ID');
const publicKey = createPublicKey(await fs.readFile(publicKeyFile));
if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength || 0) < 3072) throw new Error('Expected an RSA key of at least 3072 bits');
const key = randomBytes(32), nonce = randomBytes(12);
const aad = Buffer.from('proxy-pilot-20260920:client-0001', 'utf8');
const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const envelope = {
  version: 1,
  algorithm: 'RSA-OAEP-SHA256+A256GCM',
  taskId: reply.taskId,
  inReplyTo: reply.inReplyTo,
  encryptedKey: publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64'),
  nonce: nonce.toString('base64'),
  aad: aad.toString('base64'),
  tag: cipher.getAuthTag().toString('base64'),
  ciphertext: ciphertext.toString('base64'),
};
await fs.mkdir(path.dirname(path.resolve(targetFile)), { recursive: true });
await fs.writeFile(targetFile, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
key.fill(0); plaintext.fill(0);
console.log('Encrypted reply written: ' + targetFile);
