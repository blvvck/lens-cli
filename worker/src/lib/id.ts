/**
 * ID generation utilities for feedback worker
 * Uses Web Crypto API (available in Cloudflare Workers)
 */

/** Generate random bytes and convert to base36 string */
function randomBase36(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += array[i].toString(36);
  }
  return result.slice(0, length);
}

/** Generate a prefixed unique ID */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = randomBase36(8);
  return `${prefix}_${timestamp}${random}`;
}
