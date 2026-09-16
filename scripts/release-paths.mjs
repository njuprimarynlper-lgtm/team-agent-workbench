import fs from 'node:fs';
import path from 'node:path';

export const releaseVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Keep running installations intact when producing a newer release.
export const releaseRoot = path.resolve('release', releaseVersion);
