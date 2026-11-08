// Keeps the local API, and through it the user's Claude Code account, private to them.
//
// Listening on 127.0.0.1 stops other computers, but any program or user account on this
// machine can still connect. So every API call must present a secret key, kept in a file
// only this account can read. The browser receives it once through a private link printed
// in the terminal, and sends it in a header that other websites can't add.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY_FORMAT = /^[0-9a-f]{64}$/;
export const KEY_HEADER = 'x-inkfield-key';

export function defaultKeyPath(env = process.env) {
  if (env.INKFIELD_KEY_FILE) return env.INKFIELD_KEY_FILE;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'inkfield', 'key');
}

function readPrivateKey(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return null;
  }
  if (!info.isFile()) throw new Error(`${path} exists but is not a regular file.`);
  // A key that others could have read can't be trusted, so it gets replaced.
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    rmSync(path);
    return null;
  }
  const key = readFileSync(path, 'utf8').trim();
  if (KEY_FORMAT.test(key)) return key;
  rmSync(path);
  return null;
}

export function loadOrCreateKey(path = defaultKeyPath()) {
  const existing = readPrivateKey(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  writeFileSync(path, `${key}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

const digest = (text) => createHash('sha256').update(String(text)).digest();

export function hasValidKey(req, key) {
  if (!key) return false; // Fail closed if the server was started without a key.
  const given = req.headers[KEY_HEADER];
  return typeof given === 'string' && timingSafeEqual(digest(given), digest(key));
}
