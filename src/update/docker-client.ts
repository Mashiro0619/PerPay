import http from "node:http";
import { URL } from "node:url";

export interface DockerClientOptions {
  readonly socketPath?: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMilliseconds?: number;
  readonly pullTimeoutMilliseconds?: number;
}

export interface DockerContainerSummary {
  readonly Id: string;
  readonly Names?: readonly string[];
  readonly Image?: string;
  readonly ImageID?: string;
  readonly State?: string;
  readonly Status?: string;
  readonly Labels?: Readonly<Record<string, string>>;
}

export interface DockerNetworkEndpoint {
  readonly Aliases?: readonly string[] | null;
  readonly IPAddress?: string;
  readonly NetworkID?: string;
  readonly Links?: readonly string[] | null;
  readonly IPAMConfig?: Record<string, unknown> | null;
}

export interface DockerContainerInspect {
  readonly Id: string;
  readonly Name: string;
  readonly Image: string;
  readonly RestartCount?: number;
  readonly State: {
    readonly Status: string;
    readonly Running: boolean;
    readonly Restarting?: boolean;
    readonly OOMKilled?: boolean;
    readonly ExitCode?: number;
    readonly Error?: string;
    readonly Health?: { readonly Status?: string };
  };
  readonly Config: {
    readonly Hostname?: string;
    readonly Domainname?: string;
    readonly User?: string;
    readonly ExposedPorts?: Record<string, Record<string, never>>;
    readonly Tty?: boolean;
    readonly OpenStdin?: boolean;
    readonly StdinOnce?: boolean;
    readonly Env?: readonly string[];
    readonly Cmd?: readonly string[] | null;
    readonly Healthcheck?: Record<string, unknown>;
    readonly Image: string;
    readonly Volumes?: Record<string, Record<string, never>>;
    readonly WorkingDir?: string;
    readonly Entrypoint?: readonly string[] | string | null;
    readonly Labels?: Record<string, string>;
    readonly StopSignal?: string;
    readonly StopTimeout?: number;
  };
  readonly HostConfig: Record<string, unknown>;
  readonly NetworkSettings?: {
    readonly Networks?: Record<string, DockerNetworkEndpoint>;
  };
}

export interface DockerCreateContainerBody {
  readonly Hostname?: string;
  readonly Domainname?: string;
  readonly User?: string;
  readonly ExposedPorts?: Record<string, Record<string, never>>;
  readonly Tty?: boolean;
  readonly OpenStdin?: boolean;
  readonly StdinOnce?: boolean;
  readonly Env?: readonly string[];
  readonly Cmd?: readonly string[] | null;
  readonly Healthcheck?: Record<string, unknown>;
  readonly Image: string;
  readonly Volumes?: Record<string, Record<string, never>>;
  readonly WorkingDir?: string;
  readonly Entrypoint?: readonly string[] | string | null;
  readonly Labels?: Record<string, string>;
  readonly StopSignal?: string;
  readonly StopTimeout?: number;
  readonly HostConfig: Record<string, unknown>;
  readonly NetworkingConfig?: {
    readonly EndpointsConfig: Record<string, {
      readonly Aliases?: readonly string[];
      readonly Links?: readonly string[];
      readonly IPAMConfig?: Record<string, unknown>;
    }>;
  };
}

export class DockerApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "DockerApiError";
    this.statusCode = statusCode;
  }
}

const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PULL_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_PULL_LINE_BYTES = 64 * 1024;
const MAX_LOGS_RESPONSE_BYTES = 256 * 1024;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

export function normalizeContainerName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

/**
 * Demultiplex Docker's 8-byte stream framing ([streamType, 0, 0, 0, uint32BE len])
 * when present, falling back to plain UTF-8 text for TTY containers.
 */
export function demuxDockerLogs(buffer: Buffer, maxChars = 800): string {
  let offset = 0;
  const frames: Buffer[] = [];
  let validFrames = false;
  while (offset + 8 <= buffer.byteLength) {
    const streamType = buffer[offset]!;
    if (
      (streamType !== 0 && streamType !== 1 && streamType !== 2) ||
      buffer[offset + 1] !== 0 ||
      buffer[offset + 2] !== 0 ||
      buffer[offset + 3] !== 0
    ) {
      validFrames = false;
      break;
    }
    const frameLength = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + frameLength > buffer.byteLength) {
      validFrames = false;
      break;
    }
    frames.push(buffer.subarray(offset + 8, offset + 8 + frameLength));
    offset += 8 + frameLength;
    validFrames = true;
  }
  const text = (validFrames && offset === buffer.byteLength ? Buffer.concat(frames) : buffer).toString("utf8");
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu, "").trim().slice(-Math.max(1, maxChars));
}

function sanitizeRecreateLabels(labels: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!labels) return undefined;
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    // Drop image-stamped metadata so the recreated container inherits the new image's labels.
    if (key.startsWith("org.opencontainers.image.") || key === "com.docker.compose.image") continue;
    filtered[key] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function buildRecreateSpec(
  inspect: DockerContainerInspect,
  targetImage: string,
): {
  readonly body: DockerCreateContainerBody;
  readonly extraNetworks: ReadonlyArray<{
    readonly networkName: string;
    readonly endpointConfig: {
      readonly Aliases?: readonly string[];
      readonly Links?: readonly string[];
      readonly IPAMConfig?: Record<string, unknown>;
    };
  }>;
} {
  const shortId = inspect.Id.slice(0, 12);
  const preserveHostname = inspect.Config.Hostname && inspect.Config.Hostname !== shortId;
  const networkEntries = Object.entries(inspect.NetworkSettings?.Networks ?? {})
    .filter(([name]) => name !== "none" && name !== "host");

  const sanitizeEndpoint = (endpoint: DockerNetworkEndpoint) => {
    const aliases = endpoint.Aliases?.filter(alias => alias !== shortId);
    return {
      ...(aliases && aliases.length > 0 ? { Aliases: aliases } : {}),
      ...(endpoint.Links && endpoint.Links.length > 0 ? { Links: endpoint.Links } : {}),
      ...(endpoint.IPAMConfig ? { IPAMConfig: endpoint.IPAMConfig } : {}),
    };
  };

  // Match HostConfig.NetworkMode so primary EndpointsConfig aligns with Docker's initial network attachment.
  const hostNetworkMode = typeof inspect.HostConfig.NetworkMode === "string"
    ? inspect.HostConfig.NetworkMode
    : undefined;
  const primaryNetwork =
    (hostNetworkMode ? networkEntries.find(([name]) => name === hostNetworkMode) : undefined) ??
    networkEntries[0];
  const extraNetworks = networkEntries
    .filter(entry => entry !== primaryNetwork)
    .map(([networkName, endpoint]) => ({
      networkName,
      endpointConfig: sanitizeEndpoint(endpoint),
    }));
  const sanitizedLabels = sanitizeRecreateLabels(inspect.Config.Labels);

  const body: DockerCreateContainerBody = {
    ...(preserveHostname ? { Hostname: inspect.Config.Hostname } : {}),
    ...(inspect.Config.Domainname ? { Domainname: inspect.Config.Domainname } : {}),
    ...(inspect.Config.User !== undefined ? { User: inspect.Config.User } : {}),
    ...(inspect.Config.ExposedPorts ? { ExposedPorts: inspect.Config.ExposedPorts } : {}),
    ...(inspect.Config.Tty !== undefined ? { Tty: inspect.Config.Tty } : {}),
    ...(inspect.Config.OpenStdin !== undefined ? { OpenStdin: inspect.Config.OpenStdin } : {}),
    ...(inspect.Config.StdinOnce !== undefined ? { StdinOnce: inspect.Config.StdinOnce } : {}),
    ...(inspect.Config.Env ? { Env: [...inspect.Config.Env] } : {}),
    ...(inspect.Config.Cmd !== undefined ? { Cmd: inspect.Config.Cmd ? [...inspect.Config.Cmd] : inspect.Config.Cmd } : {}),
    ...(inspect.Config.Healthcheck ? { Healthcheck: inspect.Config.Healthcheck } : {}),
    Image: targetImage,
    ...(inspect.Config.Volumes ? { Volumes: inspect.Config.Volumes } : {}),
    ...(inspect.Config.WorkingDir !== undefined ? { WorkingDir: inspect.Config.WorkingDir } : {}),
    ...(inspect.Config.Entrypoint !== undefined ? { Entrypoint: Array.isArray(inspect.Config.Entrypoint) ? [...inspect.Config.Entrypoint] : inspect.Config.Entrypoint } : {}),
    ...(sanitizedLabels ? { Labels: sanitizedLabels } : {}),
    ...(inspect.Config.StopSignal ? { StopSignal: inspect.Config.StopSignal } : {}),
    ...(inspect.Config.StopTimeout !== undefined ? { StopTimeout: inspect.Config.StopTimeout } : {}),
    HostConfig: { ...inspect.HostConfig },
    ...(primaryNetwork ? {
      NetworkingConfig: {
        EndpointsConfig: {
          [primaryNetwork[0]]: sanitizeEndpoint(primaryNetwork[1]),
        },
      },
    } : {}),
  };

  return { body, extraNetworks };
}

/**
 * Builds an offline, non-restarting one-off maintenance container spec derived from an existing
 * app container so updater can run maintenance commands using the old image without mounting
 * business data or secret volumes into the updater container itself.
 */
export function buildOneOffMaintenanceSpec(
  inspect: DockerContainerInspect,
  cmd: readonly string[],
): DockerCreateContainerBody {
  const sanitizedHostConfig: Record<string, unknown> = { ...inspect.HostConfig };
  delete sanitizedHostConfig.PortBindings;
  delete sanitizedHostConfig.PublishAllPorts;
  delete sanitizedHostConfig.Links;
  delete sanitizedHostConfig.ExtraHosts;
  delete sanitizedHostConfig.Dns;
  delete sanitizedHostConfig.DnsOptions;
  delete sanitizedHostConfig.DnsSearch;
  sanitizedHostConfig.NetworkMode = "none";
  sanitizedHostConfig.RestartPolicy = { Name: "no" };
  sanitizedHostConfig.AutoRemove = false;

  const labels: Record<string, string> = {
    ...(sanitizeRecreateLabels(inspect.Config.Labels) ?? {}),
    "com.docker.compose.oneoff": "true",
  };

  return {
    ...(inspect.Config.User !== undefined ? { User: inspect.Config.User } : {}),
    ...(inspect.Config.Env ? { Env: [...inspect.Config.Env] } : {}),
    Entrypoint: [],
    Cmd: [...cmd],
    Healthcheck: { Test: ["NONE"] },
    Image: inspect.Image || inspect.Config.Image,
    ...(inspect.Config.Volumes ? { Volumes: inspect.Config.Volumes } : {}),
    ...(inspect.Config.WorkingDir !== undefined ? { WorkingDir: inspect.Config.WorkingDir } : {}),
    Labels: labels,
    HostConfig: sanitizedHostConfig,
  };
}

export class DockerClient {
  readonly #socketPath: string | undefined;
  readonly #baseUrl: URL | undefined;
  readonly #requestTimeoutMs: number;
  readonly #pullTimeoutMs: number;

  constructor(options: DockerClientOptions = {}) {
    if (options.baseUrl) {
      this.#baseUrl = new URL(options.baseUrl);
    } else {
      this.#socketPath = options.socketPath ?? "/var/run/docker.sock";
    }
    this.#requestTimeoutMs = options.requestTimeoutMilliseconds ?? 30_000;
    this.#pullTimeoutMs = options.pullTimeoutMilliseconds ?? 10 * 60_000;
  }

  async ping(): Promise<void> {
    const response = await this.#rawRequest("GET", "/_ping");
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerApiError(response.statusCode, `Docker ping failed (${response.statusCode})`);
    }
  }

  async listProjectContainers(project: string): Promise<DockerContainerSummary[]> {
    const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`] });
    return this.#jsonRequest<DockerContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
  }

  async inspectContainer(id: string): Promise<DockerContainerInspect> {
    return this.#jsonRequest<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(id)}/json`);
  }

  async inspectImage(reference: string): Promise<{ readonly Id: string }> {
    return this.#jsonRequest<{ readonly Id: string }>("GET", `/images/${encodeURIComponent(reference)}/json`);
  }

  async pullImage(repository: string, tag: string): Promise<void> {
    const path = `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let totalBytes = 0;
      let remainder = "";
      const errorChunks: Buffer[] = [];
      let errorBytes = 0;

      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        if (err) reject(err);
        else resolve();
      };

      const request = http.request(this.#requestOptions("POST", path, undefined, this.#pullTimeoutMs), response => {
        const statusCode = response.statusCode ?? 500;
        const ok = statusCode >= 200 && statusCode < 300;

        const inspectNdjsonLine = (line: string): string | null => {
          const trimmed = line.trim();
          if (!trimmed) return null;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return null;
          }
          const errorDetail = parsed.errorDetail as { message?: unknown } | undefined;
          if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
          if (typeof errorDetail?.message === "string" && errorDetail.message.trim()) return errorDetail.message.trim();
          return null;
        };

        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_PULL_STREAM_BYTES) {
            const err = new Error("Docker image pull stream exceeded byte limit");
            request.destroy(err);
            finish(err);
            return;
          }
          if (!ok) {
            if (errorBytes < 16 * 1024) {
              errorChunks.push(chunk);
              errorBytes += chunk.byteLength;
            }
            return;
          }
          remainder += chunk.toString("utf8");
          let newlineIndex = remainder.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = remainder.slice(0, newlineIndex);
            remainder = remainder.slice(newlineIndex + 1);
            const pullError = inspectNdjsonLine(line);
            if (pullError) {
              const err = new DockerApiError(502, `拉取镜像失败：${pullError}`);
              request.destroy();
              finish(err);
              return;
            }
            newlineIndex = remainder.indexOf("\n");
          }
          if (Buffer.byteLength(remainder, "utf8") > MAX_PULL_LINE_BYTES) {
            const err = new Error("Docker image pull NDJSON line exceeded limit");
            request.destroy(err);
            finish(err);
          }
        });

        response.on("aborted", () => {
          finish(new Error("Docker image pull stream aborted prematurely"));
        });

        response.on("end", () => {
          if (settled) return;
          if (!response.complete) {
            finish(new Error("Docker image pull stream terminated prematurely"));
            return;
          }
          if (!ok) {
            const body = Buffer.concat(errorChunks, errorBytes).toString("utf8");
            finish(new DockerApiError(statusCode, extractDockerMessage(body) ?? `拉取镜像失败（HTTP ${statusCode}）`));
            return;
          }
          const trailingError = inspectNdjsonLine(remainder);
          if (trailingError) {
            finish(new DockerApiError(502, `拉取镜像失败：${trailingError}`));
            return;
          }
          finish();
        });

        response.on("error", err => finish(err));
      });

      const wallTimer = setTimeout(() => {
        const err = new Error("Docker image pull timed out");
        request.destroy(err);
        finish(err);
      }, this.#pullTimeoutMs);

      request.on("timeout", () => {
        const err = new Error("Docker image pull timed out");
        request.destroy(err);
        finish(err);
      });
      request.on("error", err => finish(err));
      request.end();
    });
  }

  async stopContainer(id: string, timeoutSeconds = 30): Promise<void> {
    const clampedTimeout = Math.max(1, Math.trunc(timeoutSeconds));
    const requestTimeoutMs = Math.min(
      MAX_TIMER_MILLISECONDS,
      Math.max(this.#requestTimeoutMs, (clampedTimeout + 15) * 1_000),
    );
    const response = await this.#rawRequest(
      "POST",
      `/containers/${encodeURIComponent(id)}/stop?t=${clampedTimeout}`,
      undefined,
      requestTimeoutMs,
    );
    if (response.statusCode === 204 || response.statusCode === 304 || response.statusCode === 404) return;
    throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `停止容器失败（HTTP ${response.statusCode}）`);
  }

  async renameContainer(id: string, newName: string): Promise<void> {
    const response = await this.#rawRequest(
      "POST",
      `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(newName)}`,
    );
    if (response.statusCode === 204) return;
    throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `重命名容器失败（HTTP ${response.statusCode}）`);
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const response = await this.#rawRequest(
      "DELETE",
      `/containers/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
    );
    if (response.statusCode === 204 || response.statusCode === 404) return;
    throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `删除容器失败（HTTP ${response.statusCode}）`);
  }

  async createContainer(name: string, body: DockerCreateContainerBody): Promise<{ readonly Id: string }> {
    return this.#jsonRequest<{ readonly Id: string }>(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      body,
    );
  }

  async startContainer(id: string): Promise<void> {
    const response = await this.#rawRequest("POST", `/containers/${encodeURIComponent(id)}/start`);
    if (response.statusCode === 204 || response.statusCode === 304) return;
    throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `启动容器失败（HTTP ${response.statusCode}）`);
  }

  async waitContainer(
    id: string,
    timeoutMilliseconds = 10 * 60_000,
  ): Promise<{ readonly StatusCode: number; readonly Error?: { readonly Message?: string } | null }> {
    const clampedTimeoutMs = Math.min(MAX_TIMER_MILLISECONDS, Math.max(this.#requestTimeoutMs, Math.trunc(timeoutMilliseconds)));
    const response = await this.#rawRequest(
      "POST",
      `/containers/${encodeURIComponent(id)}/wait`,
      undefined,
      clampedTimeoutMs,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `等待容器退出失败（HTTP ${response.statusCode}）`);
    }
    return JSON.parse(response.body) as { readonly StatusCode: number; readonly Error?: { readonly Message?: string } | null };
  }

  async connectNetwork(
    networkName: string,
    containerId: string,
    endpointConfig?: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.#rawRequest(
      "POST",
      `/networks/${encodeURIComponent(networkName)}/connect`,
      { Container: containerId, ...(endpointConfig ? { EndpointConfig: endpointConfig } : {}) },
    );
    if (response.statusCode === 200 || response.statusCode === 204) return;
    throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `连接网络失败（HTTP ${response.statusCode}）`);
  }

  async containerLogsTail(
    id: string,
    tail = 20,
    options: { readonly stdoutOnly?: boolean; readonly maxChars?: number } = {},
  ): Promise<string> {
    const stderr = options.stdoutOnly ? "false" : "true";
    const response = await this.#rawBufferRequest(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=${stderr}&tail=${Math.max(1, Math.min(100, tail))}`,
      undefined,
      this.#requestTimeoutMs,
      MAX_LOGS_RESPONSE_BYTES,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) return "";
    return demuxDockerLogs(response.body, options.maxChars ?? (options.stdoutOnly ? 64 * 1024 : 800));
  }

  async #jsonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#rawRequest(method, path, body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `Docker API 错误（HTTP ${response.statusCode}）`);
    }
    return JSON.parse(response.body) as T;
  }

  #requestOptions(
    method: string,
    path: string,
    payload: Buffer | undefined,
    timeoutMs: number,
  ): http.RequestOptions {
    const headers: Record<string, string | number> = {
      accept: "application/json",
      ...(payload ? { "content-type": "application/json", "content-length": payload.byteLength } : {}),
    };
    return this.#baseUrl
      ? {
          protocol: this.#baseUrl.protocol,
          hostname: this.#baseUrl.hostname,
          port: this.#baseUrl.port ? Number(this.#baseUrl.port) : 80,
          path: `${this.#baseUrl.pathname.replace(/\/$/u, "")}${path}`,
          method,
          headers,
          timeout: timeoutMs,
        }
      : {
          socketPath: this.#socketPath,
          path,
          method,
          headers,
          timeout: timeoutMs,
        };
  }

  async #rawRequest(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.#requestTimeoutMs,
    maxBytes = MAX_JSON_RESPONSE_BYTES,
  ): Promise<{ readonly statusCode: number; readonly body: string }> {
    const response = await this.#rawBufferRequest(method, path, body, timeoutMs, maxBytes);
    return { statusCode: response.statusCode, body: response.body.toString("utf8") };
  }

  #rawBufferRequest(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.#requestTimeoutMs,
    maxBytes = MAX_JSON_RESPONSE_BYTES,
  ): Promise<{ readonly statusCode: number; readonly body: Buffer }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: unknown, value?: { readonly statusCode: number; readonly body: Buffer }) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        if (err) reject(err);
        else resolve(value!);
      };

      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      const request = http.request(this.#requestOptions(method, path, payload, timeoutMs), response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            const err = new Error("Docker API response exceeded byte limit");
            request.destroy(err);
            finish(err);
            return;
          }
          chunks.push(chunk);
        });
        response.on("aborted", () => {
          finish(new Error("Docker API response aborted prematurely"));
        });
        response.on("end", () => {
          if (!response.complete) {
            finish(new Error("Docker API response terminated prematurely"));
            return;
          }
          finish(null, {
            statusCode: response.statusCode ?? 500,
            body: Buffer.concat(chunks, bytes),
          });
        });
        response.on("error", err => finish(err));
      });

      const wallTimer = setTimeout(() => {
        const err = new Error("Docker API request timed out");
        request.destroy(err);
        finish(err);
      }, timeoutMs);

      request.on("timeout", () => {
        const err = new Error("Docker API request timed out");
        request.destroy(err);
        finish(err);
      });
      request.on("error", err => finish(err));
      if (payload) request.write(payload);
      request.end();
    });
  }
}

function extractDockerMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
  } catch {
    return null;
  }
}
