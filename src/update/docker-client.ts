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
const MAX_PULL_STREAM_BYTES = 16 * 1024 * 1024;

export function normalizeContainerName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
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

  const primaryNetwork = networkEntries[0];
  const extraNetworks = networkEntries.slice(1).map(([networkName, endpoint]) => ({
    networkName,
    endpointConfig: sanitizeEndpoint(endpoint),
  }));

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
    ...(inspect.Config.Labels ? { Labels: { ...inspect.Config.Labels } } : {}),
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
    const response = await this.#rawRequest("POST", path, undefined, this.#pullTimeoutMs, MAX_PULL_STREAM_BYTES);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `拉取镜像失败（HTTP ${response.statusCode}）`);
    }
    for (const line of response.body.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const errorDetail = parsed.errorDetail as { message?: unknown } | undefined;
      const message = typeof parsed.error === "string"
        ? parsed.error
        : typeof errorDetail?.message === "string"
          ? errorDetail.message
          : null;
      if (message) throw new DockerApiError(502, `拉取镜像失败：${message}`);
    }
  }

  async stopContainer(id: string, timeoutSeconds = 30): Promise<void> {
    const response = await this.#rawRequest(
      "POST",
      `/containers/${encodeURIComponent(id)}/stop?t=${Math.max(1, Math.trunc(timeoutSeconds))}`,
      undefined,
      Math.max(this.#requestTimeoutMs, (timeoutSeconds + 15) * 1_000),
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

  async containerLogsTail(id: string, tail = 20): Promise<string> {
    const response = await this.#rawRequest(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${Math.max(1, Math.min(100, tail))}`,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) return "";
    // Strip Docker multiplexed stream 8-byte headers if present, keeping printable UTF-8 lines.
    return response.body.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/gu, "").trim().slice(-800);
  }

  async #jsonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#rawRequest(method, path, body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DockerApiError(response.statusCode, extractDockerMessage(response.body) ?? `Docker API 错误（HTTP ${response.statusCode}）`);
    }
    return JSON.parse(response.body) as T;
  }

  #rawRequest(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.#requestTimeoutMs,
    maxBytes = MAX_JSON_RESPONSE_BYTES,
  ): Promise<{ readonly statusCode: number; readonly body: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      const headers: Record<string, string | number> = {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": payload.byteLength } : {}),
      };
      const requestOptions: http.RequestOptions = this.#baseUrl
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

      const request = http.request(requestOptions, response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            request.destroy(new Error("Docker API response exceeded byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 500,
            body: Buffer.concat(chunks, bytes).toString("utf8"),
          });
        });
        response.on("error", reject);
      });
      request.on("timeout", () => {
        request.destroy(new Error("Docker API request timed out"));
      });
      request.on("error", reject);
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
