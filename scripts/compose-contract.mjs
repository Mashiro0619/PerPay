import { isAlias, isScalar, parseDocument } from "yaml";

// The release template intentionally has a stable project name.  Moving the
// file must not silently select a different SQLite volume.  Operators running
// more than one instance must change this value to another unique name.
const TEMPLATE_EXTENSIONS = Object.freeze({
  "x-perpay-host-port": ["perpay-host-port", "127.0.0.1:6190:6190"],
  "x-perpay-master-key": ["perpay-master-key", "CHANGE_ME_TO_64_HEX_CHARACTERS"],
  "x-perpay-public-url": ["perpay-public-url", "http://localhost:6190"],
  "x-perpay-trusted-proxy-cidrs": ["perpay-trusted-proxy-cidrs", ""],
  "x-perpay-backup-interval-seconds": ["perpay-backup-interval-seconds", "86400"],
  "x-perpay-backup-keep-count": ["perpay-backup-keep-count", "7"],
});
const TOP_LEVEL_KEYS = new Set(["name", ...Object.keys(TEMPLATE_EXTENSIONS), "services", "volumes"]);
const APP_KEYS = new Set([
  "image",
  "environment",
  "ports",
  "volumes",
  "user",
  "restart",
  "stop_grace_period",
  "read_only",
  "tmpfs",
  "security_opt",
  "cap_drop",
  "init",
  "healthcheck",
  "logging",
]);
const BACKUP_KEYS = new Set([
  "image",
  "environment",
  "volumes",
  "user",
  "command",
  "depends_on",
  "restart",
  "stop_grace_period",
  "read_only",
  "tmpfs",
  "security_opt",
  "cap_drop",
  "init",
  "network_mode",
  "healthcheck",
  "logging",
]);
const MAINTENANCE_KEYS = new Set([
  "image",
  "profiles",
  "environment",
  "volumes",
  "user",
  "entrypoint",
  "read_only",
  "tmpfs",
  "security_opt",
  "cap_drop",
  "init",
  "network_mode",
]);
const ENVIRONMENT_KEYS = new Set([
  "PERPAY_MASTER_KEY",
  "PERPAY_PUBLIC_URL",
  "PERPAY_TRUSTED_PROXY_CIDRS",
  "PERPAY_BACKUP_INTERVAL_SECONDS",
]);
const RELEASE_TEMPLATE_ENVIRONMENT = Object.freeze({
  PERPAY_MASTER_KEY: "CHANGE_ME_TO_64_HEX_CHARACTERS",
  PERPAY_PUBLIC_URL: "http://localhost:6190",
  PERPAY_TRUSTED_PROXY_CIDRS: "",
  PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
});
const BACKUP_ENVIRONMENT_KEYS = new Set([
  "PERPAY_DATA_DIR",
  "PERPAY_BACKUP_DIR",
  "PERPAY_BACKUP_INTERVAL_SECONDS",
  "PERPAY_BACKUP_KEEP_COUNT",
]);
const RELEASE_TEMPLATE_BACKUP_ENVIRONMENT = Object.freeze({
  PERPAY_DATA_DIR: "/data",
  PERPAY_BACKUP_DIR: "/backups",
  PERPAY_BACKUP_INTERVAL_SECONDS: "86400",
  PERPAY_BACKUP_KEEP_COUNT: "7",
});
const HEALTHCHECK_KEYS = new Set(["test", "interval", "timeout", "start_period", "retries"]);
const LOGGING_KEYS = new Set(["driver", "options"]);
const LOGGING_OPTION_KEYS = new Set(["max-size", "max-file"]);

function assertExactKeys(value, allowed, label) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported key: ${key}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertExactArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length ||
      value.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} does not match the release security contract`);
  }
}

function assertAlias(document, path, anchor, label) {
  const node = document.getIn(path, true);
  if (!isAlias(node) || node.source !== anchor) {
    throw new Error(`Compose ${label} must reference the ${anchor} anchor`);
  }
}

/**
 * Parses the user-facing Compose file and enforces the release contract. The
 * two default services and the profile-gated maintenance service run the same
 * identical application image reference or channel.
 */
export function inspectComposeContract(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("Compose source must be a non-empty string");
  }
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    throw new Error(`Compose YAML is invalid: ${document.errors[0].message}`);
  }
  const value = document.toJS();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Compose root must be a mapping");
  }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`Compose has unsupported top-level key: ${key}`);
  }
  if (value.name !== "perpay") {
    throw new Error("release Compose project name must retain the official template value");
  }
  for (const [extension, [anchor, expected]] of Object.entries(TEMPLATE_EXTENSIONS)) {
    const node = document.get(extension, true);
    if (!isScalar(node) || node.value !== expected || node.anchor !== anchor) {
      throw new Error(`release Compose ${extension} must retain its anchored template value`);
    }
  }
  const services = value.services;
  if (services === null || typeof services !== "object" || Array.isArray(services)) {
    throw new Error("Compose services must be a mapping");
  }
  const serviceNames = Object.keys(services);
  if (serviceNames.sort().join(",") !== "app,backup,maintenance") {
    throw new Error("Compose must contain exactly the app, backup, and maintenance services");
  }
  const app = services.app;
  if (app === null || typeof app !== "object" || Array.isArray(app)) {
    throw new Error("Compose app service must be a mapping");
  }
  assertExactKeys(app, APP_KEYS, "Compose app service");
  const environment = app.environment;
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Compose app.environment must be a mapping");
  }
  assertExactKeys(environment, ENVIRONMENT_KEYS, "Compose app.environment");
  if (Object.keys(environment).length !== ENVIRONMENT_KEYS.size) {
    throw new Error("Compose app.environment is missing a required configuration key");
  }
  for (const [key, expected] of Object.entries(RELEASE_TEMPLATE_ENVIRONMENT)) {
    const item = environment[key];
    if (key === "PERPAY_TRUSTED_PROXY_CIDRS") {
      if (typeof item !== "string") {
        throw new Error(`Compose environment ${key} must be a string`);
      }
    } else {
      assertString(item, `Compose environment ${key}`);
    }
    if (item !== expected) {
      throw new Error(`Compose environment ${key} must retain its release template value`);
    }
  }
  assertAlias(document, ["services", "app", "ports", 0], "perpay-host-port", "app.ports[0]");
  assertAlias(document, ["services", "app", "environment", "PERPAY_MASTER_KEY"], "perpay-master-key", "app.environment.PERPAY_MASTER_KEY");
  assertAlias(document, ["services", "app", "environment", "PERPAY_PUBLIC_URL"], "perpay-public-url", "app.environment.PERPAY_PUBLIC_URL");
  assertAlias(document, ["services", "app", "environment", "PERPAY_TRUSTED_PROXY_CIDRS"], "perpay-trusted-proxy-cidrs", "app.environment.PERPAY_TRUSTED_PROXY_CIDRS");
  assertAlias(document, ["services", "app", "environment", "PERPAY_BACKUP_INTERVAL_SECONDS"], "perpay-backup-interval-seconds", "app.environment.PERPAY_BACKUP_INTERVAL_SECONDS");

  assertExactArray(app.ports, ["127.0.0.1:6190:6190"], "Compose app.ports");
  assertExactArray(
    app.volumes,
    ["perpay-data:/data", "perpay-backups:/backups:ro"],
    "Compose app.volumes",
  );
  if (app.user !== "1000:1000" || app.restart !== "unless-stopped" ||
      app.stop_grace_period !== "45s" || app.read_only !== true || app.init !== true) {
    throw new Error("Compose app runtime identity or lifecycle settings are unsafe");
  }
  assertExactArray(app.tmpfs, ["/tmp:size=32m,mode=1777"], "Compose app.tmpfs");
  assertExactArray(app.security_opt, ["no-new-privileges:true"], "Compose app.security_opt");
  assertExactArray(app.cap_drop, ["ALL"], "Compose app.cap_drop");

  const healthcheck = app.healthcheck;
  if (healthcheck === null || typeof healthcheck !== "object" || Array.isArray(healthcheck)) {
    throw new Error("Compose app.healthcheck must be a mapping");
  }
  assertExactKeys(healthcheck, HEALTHCHECK_KEYS, "Compose app.healthcheck");
  assertExactArray(
    healthcheck.test,
    ["CMD", "node", "-e", "fetch('http://127.0.0.1:6190/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
    "Compose app.healthcheck.test",
  );
  if (healthcheck.interval !== "30s" || healthcheck.timeout !== "5s" ||
      healthcheck.start_period !== "5m" || healthcheck.retries !== 3) {
    throw new Error("Compose app.healthcheck settings are unsafe");
  }

  const logging = app.logging;
  if (logging === null || typeof logging !== "object" || Array.isArray(logging)) {
    throw new Error("Compose app.logging must be a mapping");
  }
  assertExactKeys(logging, LOGGING_KEYS, "Compose app.logging");
  if (logging.driver !== "json-file" || logging.options === null ||
      typeof logging.options !== "object" || Array.isArray(logging.options)) {
    throw new Error("Compose app.logging settings are unsafe");
  }
  assertExactKeys(logging.options, LOGGING_OPTION_KEYS, "Compose app.logging.options");
  if (logging.options["max-size"] !== "10m" || logging.options["max-file"] !== "3") {
    throw new Error("Compose app.logging limits are unsafe");
  }

  const backup = services.backup;
  if (backup === null || typeof backup !== "object" || Array.isArray(backup)) {
    throw new Error("Compose backup service must be a mapping");
  }
  assertExactKeys(backup, BACKUP_KEYS, "Compose backup service");
  if (backup.environment === null || typeof backup.environment !== "object" ||
      Array.isArray(backup.environment)) {
    throw new Error("Compose backup.environment must be a mapping");
  }
  assertExactKeys(backup.environment, BACKUP_ENVIRONMENT_KEYS, "Compose backup.environment");
  if (Object.keys(backup.environment).length !== BACKUP_ENVIRONMENT_KEYS.size) {
    throw new Error("Compose backup.environment is missing a required configuration key");
  }
  for (const [key, expected] of Object.entries(RELEASE_TEMPLATE_BACKUP_ENVIRONMENT)) {
    assertString(backup.environment[key], `Compose backup environment ${key}`);
    if (backup.environment[key] !== expected) {
      throw new Error(`Compose backup environment ${key} must retain its release template value`);
    }
  }
  assertAlias(
    document,
    ["services", "backup", "environment", "PERPAY_BACKUP_INTERVAL_SECONDS"],
    "perpay-backup-interval-seconds",
    "backup.environment.PERPAY_BACKUP_INTERVAL_SECONDS",
  );
  assertAlias(
    document,
    ["services", "backup", "environment", "PERPAY_BACKUP_KEEP_COUNT"],
    "perpay-backup-keep-count",
    "backup.environment.PERPAY_BACKUP_KEEP_COUNT",
  );
  assertExactArray(
    backup.volumes,
    ["perpay-data:/data:ro", "perpay-backups:/backups"],
    "Compose backup.volumes",
  );
  assertExactArray(
    backup.command,
    ["node", "dist/backup/runner.js", "schedule"],
    "Compose backup.command",
  );
  if (backup.user !== "1000:1000" || backup.restart !== "unless-stopped" ||
      backup.stop_grace_period !== "60s" || backup.read_only !== true || backup.init !== true ||
      backup.network_mode !== "none") {
    throw new Error("Compose backup runtime identity, lifecycle, or network settings are unsafe");
  }
  assertExactArray(backup.tmpfs, ["/tmp:size=64m,mode=1777"], "Compose backup.tmpfs");
  assertExactArray(backup.security_opt, ["no-new-privileges:true"], "Compose backup.security_opt");
  assertExactArray(backup.cap_drop, ["ALL"], "Compose backup.cap_drop");
  if (JSON.stringify(backup.depends_on) !== JSON.stringify({ app: { condition: "service_healthy" } })) {
    throw new Error("Compose backup must wait for the healthy app service");
  }
  const backupHealthcheck = backup.healthcheck;
  if (backupHealthcheck === null || typeof backupHealthcheck !== "object" ||
      Array.isArray(backupHealthcheck)) {
    throw new Error("Compose backup.healthcheck must be a mapping");
  }
  assertExactKeys(backupHealthcheck, HEALTHCHECK_KEYS, "Compose backup.healthcheck");
  assertExactArray(
    backupHealthcheck.test,
    ["CMD", "node", "dist/backup/runner.js", "health"],
    "Compose backup.healthcheck.test",
  );
  if (backupHealthcheck.interval !== "5m" || backupHealthcheck.timeout !== "10s" ||
      backupHealthcheck.start_period !== "10m" || backupHealthcheck.retries !== 3) {
    throw new Error("Compose backup.healthcheck settings are unsafe");
  }
  const backupLogging = backup.logging;
  if (backupLogging === null || typeof backupLogging !== "object" ||
      Array.isArray(backupLogging) || backupLogging.driver !== "json-file" ||
      backupLogging.options === null || typeof backupLogging.options !== "object" ||
      Array.isArray(backupLogging.options)) {
    throw new Error("Compose backup.logging settings are unsafe");
  }
  assertExactKeys(backupLogging, LOGGING_KEYS, "Compose backup.logging");
  assertExactKeys(backupLogging.options, LOGGING_OPTION_KEYS, "Compose backup.logging.options");
  if (backupLogging.options["max-size"] !== "10m" || backupLogging.options["max-file"] !== "3") {
    throw new Error("Compose backup.logging limits are unsafe");
  }

  const maintenance = services.maintenance;
  if (maintenance === null || typeof maintenance !== "object" || Array.isArray(maintenance)) {
    throw new Error("Compose maintenance service must be a mapping");
  }
  assertExactKeys(maintenance, MAINTENANCE_KEYS, "Compose maintenance service");
  assertExactArray(maintenance.profiles, ["maintenance"], "Compose maintenance.profiles");
  if (maintenance.environment === null || typeof maintenance.environment !== "object" ||
      Array.isArray(maintenance.environment)) {
    throw new Error("Compose maintenance.environment must be a mapping");
  }
  assertExactKeys(
    maintenance.environment,
    BACKUP_ENVIRONMENT_KEYS,
    "Compose maintenance.environment",
  );
  if (Object.keys(maintenance.environment).length !== BACKUP_ENVIRONMENT_KEYS.size) {
    throw new Error("Compose maintenance.environment is missing a required configuration key");
  }
  for (const [key, expected] of Object.entries(RELEASE_TEMPLATE_BACKUP_ENVIRONMENT)) {
    assertString(maintenance.environment[key], `Compose maintenance environment ${key}`);
    if (maintenance.environment[key] !== expected) {
      throw new Error(`Compose maintenance environment ${key} must retain its release template value`);
    }
  }
  assertAlias(
    document,
    ["services", "maintenance", "environment", "PERPAY_BACKUP_INTERVAL_SECONDS"],
    "perpay-backup-interval-seconds",
    "maintenance.environment.PERPAY_BACKUP_INTERVAL_SECONDS",
  );
  assertAlias(
    document,
    ["services", "maintenance", "environment", "PERPAY_BACKUP_KEEP_COUNT"],
    "perpay-backup-keep-count",
    "maintenance.environment.PERPAY_BACKUP_KEEP_COUNT",
  );
  assertExactArray(
    maintenance.volumes,
    ["perpay-data:/data", "perpay-backups:/backups"],
    "Compose maintenance.volumes",
  );
  assertExactArray(
    maintenance.entrypoint,
    ["node", "dist/backup/runner.js"],
    "Compose maintenance.entrypoint",
  );
  if (maintenance.user !== "1000:1000" || maintenance.read_only !== true ||
      maintenance.init !== true || maintenance.network_mode !== "none") {
    throw new Error("Compose maintenance runtime identity or isolation settings are unsafe");
  }
  assertExactArray(
    maintenance.tmpfs,
    ["/tmp:size=64m,mode=1777"],
    "Compose maintenance.tmpfs",
  );
  assertExactArray(
    maintenance.security_opt,
    ["no-new-privileges:true"],
    "Compose maintenance.security_opt",
  );
  assertExactArray(maintenance.cap_drop, ["ALL"], "Compose maintenance.cap_drop");

  const volumes = value.volumes;
  if (volumes === null || typeof volumes !== "object" || Array.isArray(volumes) ||
      Object.keys(volumes).sort().join(",") !== "perpay-backups,perpay-data") {
    throw new Error("Compose must declare exactly the data and backup volumes");
  }
  for (const name of ["perpay-data", "perpay-backups"]) {
    if (volumes[name] !== null &&
        (typeof volumes[name] !== "object" || Object.keys(volumes[name]).length !== 0)) {
      throw new Error(`Compose ${name} must be a local managed volume`);
    }
  }
  const imageNodes = ["app", "backup", "maintenance"].map((service) => {
    const node = document.getIn(["services", service, "image"], true);
    if (!isScalar(node) || typeof node.value !== "string" || node.value.length === 0) {
      throw new Error(`Compose ${service}.image must be a non-empty scalar string`);
    }
    if (node.range === undefined || node.range.length < 2) {
      throw new Error(`Compose ${service}.image has no source range`);
    }
    return node;
  });
  if (imageNodes.some((node) => node.value !== imageNodes[0].value)) {
    throw new Error("Compose app, backup, and maintenance must use the same image reference");
  }
  return Object.freeze({ document, imageNodes: Object.freeze(imageNodes), image: imageNodes[0].value });
}

export function replaceComposeImage(source, image) {
  if (typeof image !== "string" || image.length === 0) {
    throw new TypeError("replacement image must be a non-empty string");
  }
  const contract = inspectComposeContract(source);
  let rendered = source;
  const ranges = contract.imageNodes.map((node) => node.range).sort((left, right) => right[0] - left[0]);
  for (const [start, end] of ranges) {
    rendered = `${rendered.slice(0, start)}${image}${rendered.slice(end)}`;
  }
  return rendered;
}
