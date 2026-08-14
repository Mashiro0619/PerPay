import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

const PASSWORD_HASH_SCHEME = "perpay";
const PASSWORD_HASH_ALGORITHM = "scrypt";
const PASSWORD_HASH_VERSION = 1;
const SCRYPT_N = 65_536;
const SCRYPT_R = 8;
const SCRYPT_P = 2;
const SCRYPT_DERIVED_KEY_BYTES = 32;
const SCRYPT_MAX_MEMORY_BYTES = 96 * 1024 * 1024;
const PASSWORD_SALT_BYTES = 16;
const MAX_PASSWORD_BYTES = 1024;
const MAX_PASSWORD_HASH_CHARACTERS = 256;
const MAX_PARAMETER_DIGITS = 9;

const TOKEN_RANDOM_BYTES = 32;
const MAX_TOKEN_CHARACTERS = 128;
const SESSION_TOKEN_PREFIX = "ps1_";
const CSRF_TOKEN_PREFIX = "pc1_";
const TOKEN_PAYLOAD_CHARACTERS = 43;
const TOKEN_DIGEST_BYTES = 32;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const decimalPattern = /^(?:0|[1-9][0-9]*)$/;
const digestPattern = /^[0-9a-f]{64}$/;

const scryptOptions: Readonly<ScryptOptions> = Object.freeze({
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAX_MEMORY_BYTES,
});

interface ParsedPasswordHash {
  readonly salt: Buffer;
  readonly derivedKey: Buffer;
}

export interface IssuedToken {
  readonly token: string;
  readonly digest: string;
}

function assertPassword(password: string): void {
  if (typeof password !== "string") {
    throw new TypeError("Password must be a string.");
  }

  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength === 0 || byteLength > MAX_PASSWORD_BYTES) {
    throw new RangeError(`Password must contain between 1 and ${MAX_PASSWORD_BYTES} UTF-8 bytes.`);
  }
}

function derivePasswordKey(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_DERIVED_KEY_BYTES,
      scryptOptions,
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

function parseBoundedDecimal(value: string, maximum: number): number | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_PARAMETER_DIGITS ||
    !decimalPattern.test(value)
  ) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : undefined;
}

function parseParameters(value: string): boolean {
  const entries = value.split(",");
  if (entries.length !== 4) return false;

  const expectedNames = ["N", "r", "p", "dk"] as const;
  const maxima = [SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DERIVED_KEY_BYTES] as const;
  const expectedValues = [SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DERIVED_KEY_BYTES] as const;

  for (let index = 0; index < expectedNames.length; index += 1) {
    const entry = entries[index];
    const expectedName = expectedNames[index];
    const maximum = maxima[index];
    const expectedValue = expectedValues[index];
    if (
      entry === undefined ||
      expectedName === undefined ||
      maximum === undefined ||
      expectedValue === undefined
    ) {
      return false;
    }

    const separator = entry.indexOf("=");
    if (separator <= 0 || entry.indexOf("=", separator + 1) !== -1) return false;
    if (entry.slice(0, separator) !== expectedName) return false;

    const parsed = parseBoundedDecimal(entry.slice(separator + 1), maximum);
    if (parsed !== expectedValue) return false;
  }

  return true;
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer | undefined {
  if (!base64UrlPattern.test(value)) return undefined;

  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64url") !== value) {
    return undefined;
  }
  return decoded;
}

function parsePasswordHash(encodedHash: string): ParsedPasswordHash | undefined {
  if (
    typeof encodedHash !== "string" ||
    encodedHash.length === 0 ||
    encodedHash.length > MAX_PASSWORD_HASH_CHARACTERS ||
    !encodedHash.startsWith("$")
  ) {
    return undefined;
  }

  const parts = encodedHash.split("$");
  if (
    parts.length !== 7 ||
    parts[0] !== "" ||
    parts[1] !== PASSWORD_HASH_SCHEME ||
    parts[2] !== PASSWORD_HASH_ALGORITHM ||
    parts[3] !== `v=${PASSWORD_HASH_VERSION}` ||
    parts[4] === undefined ||
    parts[5] === undefined ||
    parts[6] === undefined ||
    !parseParameters(parts[4])
  ) {
    return undefined;
  }

  const salt = decodeCanonicalBase64Url(parts[5], PASSWORD_SALT_BYTES);
  const derivedKey = decodeCanonicalBase64Url(parts[6], SCRYPT_DERIVED_KEY_BYTES);
  if (salt === undefined || derivedKey === undefined) return undefined;

  return { salt, derivedKey };
}

function serializePasswordHash(salt: Uint8Array, derivedKey: Uint8Array): string {
  const parameters = `N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P},dk=${SCRYPT_DERIVED_KEY_BYTES}`;
  return [
    "",
    PASSWORD_HASH_SCHEME,
    PASSWORD_HASH_ALGORITHM,
    `v=${PASSWORD_HASH_VERSION}`,
    parameters,
    Buffer.from(salt).toString("base64url"),
    Buffer.from(derivedKey).toString("base64url"),
  ].join("$");
}

export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);

  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derivedKey = await derivePasswordKey(password, salt);
  return serializePasswordHash(salt, derivedKey);
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  assertPassword(password);

  const parsedHash = parsePasswordHash(encodedHash);
  if (parsedHash === undefined) return false;

  const candidate = await derivePasswordKey(password, parsedHash.salt);
  return timingSafeEqual(candidate, parsedHash.derivedKey);
}

function tokenPrefix(kind: "session" | "csrf"): string {
  return kind === "session" ? SESSION_TOKEN_PREFIX : CSRF_TOKEN_PREFIX;
}

function isCanonicalToken(token: string): boolean {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_CHARACTERS
  ) {
    return false;
  }

  const prefix = token.startsWith(SESSION_TOKEN_PREFIX)
    ? SESSION_TOKEN_PREFIX
    : token.startsWith(CSRF_TOKEN_PREFIX)
      ? CSRF_TOKEN_PREFIX
      : undefined;
  if (prefix === undefined) return false;

  const payload = token.slice(prefix.length);
  return (
    payload.length === TOKEN_PAYLOAD_CHARACTERS &&
    decodeCanonicalBase64Url(payload, TOKEN_RANDOM_BYTES) !== undefined
  );
}

function calculateTokenDigest(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("hex");
}

function issueToken(kind: "session" | "csrf"): IssuedToken {
  const token = `${tokenPrefix(kind)}${randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
  return Object.freeze({ token, digest: calculateTokenDigest(token) });
}

export function issueSessionToken(): IssuedToken {
  return issueToken("session");
}

export function issueCsrfToken(): IssuedToken {
  return issueToken("csrf");
}

export function digestToken(token: string): string {
  if (!isCanonicalToken(token)) {
    throw new TypeError("Token is not a canonical PerPay session or CSRF token.");
  }
  return calculateTokenDigest(token);
}

export function tokenMatchesDigest(token: string, expectedDigest: string): boolean {
  if (!isCanonicalToken(token) || !digestPattern.test(expectedDigest)) return false;

  const actual = Buffer.from(calculateTokenDigest(token), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return (
    actual.byteLength === TOKEN_DIGEST_BYTES &&
    expected.byteLength === TOKEN_DIGEST_BYTES &&
    timingSafeEqual(actual, expected)
  );
}
