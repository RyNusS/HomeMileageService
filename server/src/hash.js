// Secret hashing with Node built-in scrypt.
// Format: scrypt$N$salt_b64$hash_b64  (algorithm prefix allows future migration)
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 16384;

export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const key = await scrypt(String(secret), salt, 32, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret, stored) {
  try {
    const [algo, n, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(String(secret), salt, expected.length, { N: Number(n) });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
