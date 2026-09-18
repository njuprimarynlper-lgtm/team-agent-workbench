export function serverIdentityKey(host: string, port: number): string {
  return JSON.stringify([host.trim().toLowerCase(), port]);
}
