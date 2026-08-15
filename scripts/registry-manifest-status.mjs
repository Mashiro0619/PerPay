import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const IMAGE_PATTERN = /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)$/u;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function parseBearerChallenge(header, expectedScope) {
  if (typeof header !== "string" || !/^Bearer\s+/iu.test(header)) {
    throw new Error("GHCR did not return a Bearer authentication challenge");
  }
  const source = header.replace(/^Bearer\s+/iu, "");
  const parameters = new Map();
  let offset = 0;
  const pattern = /\s*([a-z]+)="([^"]*)"\s*(?:,|$)/giy;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (match === null || parameters.has(match[1].toLowerCase())) {
      throw new Error("GHCR returned a malformed Bearer authentication challenge");
    }
    parameters.set(match[1].toLowerCase(), match[2]);
    offset = pattern.lastIndex;
  }
  if (parameters.size !== 3 || parameters.get("realm") !== "https://ghcr.io/token" ||
      parameters.get("service") !== "ghcr.io" || parameters.get("scope") !== expectedScope) {
    throw new Error("GHCR returned an unexpected Bearer authentication challenge");
  }
}

async function discard(response) {
  await response.body?.cancel();
}

async function requestManifest(fetchImpl, manifestUrl, token) {
  const headers = { Accept: ACCEPT };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return await fetchImpl(manifestUrl, {
    method: "HEAD",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}

function manifestRequestDetails(image, version, fetchImpl) {
  const imageMatch = IMAGE_PATTERN.exec(image);
  if (imageMatch === null) throw new Error("image must be a lowercase ghcr.io repository");
  if (!VERSION_PATTERN.test(version)) throw new Error("reference must be a stable semantic version");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  const repository = imageMatch[1];
  return Object.freeze({
    manifestUrl: `https://ghcr.io/v2/${repository}/manifests/${version}`,
    scope: `repository:${repository}:pull`,
  });
}

async function requestAnonymousManifest(image, version, fetchImpl) {
  const { manifestUrl, scope } = manifestRequestDetails(image, version, fetchImpl);
  let response = await requestManifest(fetchImpl, manifestUrl);
  if (response.status === 401) {
    parseBearerChallenge(response.headers.get("www-authenticate"), scope);
    await discard(response);
    const tokenUrl = new URL("https://ghcr.io/token");
    tokenUrl.searchParams.set("service", "ghcr.io");
    tokenUrl.searchParams.set("scope", scope);
    const tokenResponse = await fetchImpl(tokenUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (tokenResponse.status !== 200) {
      await discard(tokenResponse);
      throw new Error(`GHCR anonymous token request failed with HTTP ${tokenResponse.status}`);
    }
    const tokenPayload = await tokenResponse.json();
    const token = tokenPayload !== null && typeof tokenPayload === "object"
      ? tokenPayload.token
      : undefined;
    if (typeof token !== "string" || token.length < 16 || token.length > 16_384) {
      throw new Error("GHCR returned an invalid anonymous token");
    }
    response = await requestManifest(fetchImpl, manifestUrl, token);
  }
  return response;
}

export async function queryGhcrVersionTag(image, version, fetchImpl = globalThis.fetch) {
  const response = await requestAnonymousManifest(image, version, fetchImpl);
  const status = response.status;
  await discard(response);
  if (status === 200) return "exists";
  if (status === 404) return "missing";
  throw new Error(`GHCR manifest lookup returned unexpected HTTP ${status}`);
}

export async function queryGhcrManifestDigest(image, version, fetchImpl = globalThis.fetch) {
  const response = await requestAnonymousManifest(image, version, fetchImpl);
  const status = response.status;
  const digest = response.headers.get("docker-content-digest");
  await discard(response);
  if (status !== 200) {
    throw new Error(`GHCR manifest digest lookup returned unexpected HTTP ${status}`);
  }
  if (digest === null || !DIGEST_PATTERN.test(digest)) {
    throw new Error("GHCR manifest response did not include a canonical SHA-256 digest");
  }
  return digest;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [image, version, mode] = process.argv.slice(2);
  const operation = mode === "--digest"
    ? queryGhcrManifestDigest(image, version)
    : mode === undefined
      ? queryGhcrVersionTag(image, version)
      : Promise.reject(new Error("usage: registry-manifest-status IMAGE VERSION [--digest]"));
  operation
    .then((value) => process.stdout.write(`${value}\n`))
    .catch((error) => {
      process.stderr.write(`registry status: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
