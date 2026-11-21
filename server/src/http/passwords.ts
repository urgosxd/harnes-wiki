import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing, and the only place a password is ever turned into something the
 * database may keep.
 *
 * ## Why scrypt
 *
 * scrypt is memory-hard: raising the cost raises the RAM a guess needs, so a GPU farm
 * gains much less from parallelism than it would against a fast hash. It ships in
 * `node:crypto`, which matters here more than a benchmark: a password hash is exactly
 * the kind of code an operator cannot audit, so every dependency added to it is a
 * supply-chain decision taken on trust. There is no dependency to audit if there is no
 * dependency.
 *
 * ## Why the parameters are stored in the hash
 *
 * The stored shape is `scrypt$1$<N>$<r>$<p>$<saltB64>$<hashB64>`. The cost parameters
 * travel with the hash so a future bump (`N` doubles as hardware gets faster) still
 * VERIFIES the hashes written today: verification recomputes with the parameters the
 * hash carries, not with whatever this file says is current. Storing only
 * `salt$hash` would turn "raise the cost" into "every existing user must reset their
 * password", which is how a cost bump quietly stops happening.
 *
 * `$1` is the format version, not the cost. A future change to the LAYOUT (a different
 * KDF, a different encoding) gets a new version, and an old version this file no
 * longer understands verifies as `false` rather than as a crash.
 */

/** Shortest password accepted. Also bounds the work an unauthenticated caller can cause. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Longest password accepted.
 *
 * A bound on the input, not on its strength: scrypt hashes whatever it is given, so an
 * unbounded field is an unbounded amount of work per request.
 */
export const MAX_PASSWORD_LENGTH = 200;

/** Current cost. `128 * N * r` bytes is what scrypt will allocate for one call. */
const CURRENT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const FORMAT_VERSION = "1";

/**
 * Bounds on the parameters read back out of a stored hash.
 *
 * They are ours, not a caller's — but a stored row is data, and data that can name a
 * cost is data that can name a denial of service. A `N` of 2^30 in a row would stall
 * the process for as long as scrypt takes to allocate gigabytes, so the reader refuses
 * anything outside the range this file could have written.
 */
const PARAM_LIMITS = {
  N: { min: 1024, max: 1_048_576 },
  r: { min: 1, max: 32 },
  p: { min: 1, max: 16 },
} as const;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function boundsError(): Error {
  return new Error(
    `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
  );
}

function withinBounds(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

/** `scrypt` as a promise. Wrapped by hand so the options type is ours to control. */
function derive(password: string, salt: Buffer, keyBytes: number, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyBytes,
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

/** Base64 as this file writes it: standard alphabet, padded. */
function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Parse a stored value, or `undefined` when it is not one this file could have written.
 *
 * Every rejection path returns `undefined` rather than throwing: the caller's answer is
 * "this does not verify", and a malformed row is not a reason for a 500.
 */
function parseStored(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | undefined {
  const parts = stored.split("$");
  if (parts.length !== 7) return undefined;

  const [scheme, version, rawN, rawR, rawP, saltB64, keyB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== "scrypt" || version !== FORMAT_VERSION) return undefined;

  // `Number()` on the raw text, then a re-render check, so "0x400" and "1e4" are not
  // silently accepted as parameters this file never writes.
  const readParam = (raw: string, limit: { min: number; max: number }): number | undefined => {
    if (!/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < limit.min || value > limit.max) return undefined;
    return value;
  };

  const N = readParam(rawN, PARAM_LIMITS.N);
  const r = readParam(rawR, PARAM_LIMITS.r);
  const p = readParam(rawP, PARAM_LIMITS.p);
  if (N === undefined || r === undefined || p === undefined) return undefined;
  // scrypt itself rejects a non-power-of-two N; refusing here keeps that a `false`
  // rather than a thrown range error from deep inside the KDF.
  if ((N & (N - 1)) !== 0) return undefined;

  if (!saltB64 || !keyB64 || !isBase64(saltB64) || !isBase64(keyB64)) return undefined;

  const salt = Buffer.from(saltB64, "base64");
  const key = Buffer.from(keyB64, "base64");
  if (salt.length === 0 || key.length === 0) return undefined;

  return { params: { N, r, p }, salt, key };
}

/**
 * Hash a password for storage.
 *
 * Throws when the password is outside the length bounds: that is a refusal of the
 * input, and the caller must be able to tell it apart from a successful hash.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!withinBounds(password)) throw boundsError();

  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, CURRENT_PARAMS);

  return [
    "scrypt",
    FORMAT_VERSION,
    CURRENT_PARAMS.N,
    CURRENT_PARAMS.r,
    CURRENT_PARAMS.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Does `password` produce `stored`?
 *
 * Returns `false` — never throws — for a malformed or unsupported stored value, and for
 * a candidate outside the length bounds (which skips scrypt entirely, since no stored
 * hash can have come from such a password). The comparison is constant-time so a
 * near-miss leaks no signal about how near it was.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!withinBounds(password)) return false;

  const parsed = parseStored(stored);
  if (!parsed) return false;

  // Recompute with the STORED parameters: that is what makes a cost bump a change to
  // CURRENT_PARAMS instead of a migration.
  let candidate: Buffer;
  try {
    candidate = await derive(password, parsed.salt, parsed.key.length, parsed.params);
  } catch {
    return false;
  }

  // timingSafeEqual requires equal lengths; the length itself is not the secret.
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}
