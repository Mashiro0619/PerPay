import { isAlias, isScalar, parseDocument } from "yaml";

const TEMPLATE_EXTENSIONS = Object.freeze({
  "x-perpay-host-port": ["perpay-host-port", "127.0.0.1:6190:6190"],
  "x-perpay-public-url": ["perpay-public-url", "https://pay.example.com"],
  "x-perpay-trusted-proxy-cidrs": ["perpay-trusted-proxy-cidrs", ""],
});
const TOP_LEVEL_KEYS = new Set(["name", ...Object.keys(TEMPLATE_EXTENSIONS), "services", "volumes"]);
const APP_KEYS = new Set(["image", "environment", "ports", "volumes", "user", "restart", "stop_grace_period", "read_only", "tmpfs", "security_opt", "cap_drop", "init", "healthcheck", "logging"]);
const BACKUP_KEYS = new Set(["image", "environment", "volumes", "user", "command", "depends_on", "restart", "stop_grace_period", "read_only", "tmpfs", "security_opt", "cap_drop", "init", "network_mode", "healthcheck", "logging"]);
const MAINTENANCE_KEYS = new Set(["image", "profiles", "environment", "volumes", "user", "entrypoint", "read_only", "tmpfs", "security_opt", "cap_drop", "init", "network_mode"]);
const LOGGING_KEYS = new Set(["driver", "options"]);
const LOGGING_OPTION_KEYS = new Set(["max-size", "max-file"]);

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unsupported key: ${key}`);
}
function string(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}
function array(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) throw new Error(`${label} does not match the release contract`);
}
function alias(document, path, source, label) {
  const node = document.getIn(path, true);
  if (!isAlias(node) || node.source !== source) throw new Error(`Compose ${label} must reference the ${source} anchor`);
}
function serviceEnvironment(value, expected, label) {
  exactKeys(value, new Set(Object.keys(expected)), label);
  if (Object.keys(value).length !== Object.keys(expected).length) throw new Error(`${label} is missing a required configuration key`);
  for (const [key, value_] of Object.entries(expected)) {
    if (typeof value[key] !== "string" || value[key] !== value_) throw new Error(`Compose environment ${key} must retain its anchored template value`);
  }
}
function checkLogging(value, label) {
  exactKeys(value, LOGGING_KEYS, label);
  exactKeys(value.options, LOGGING_OPTION_KEYS, `${label}.options`);
  if (value.driver !== "json-file" || value.options["max-size"] !== "10m" || value.options["max-file"] !== "3") throw new Error(`${label} limits are unsafe`);
}
function checkCommon(value, label, networkMode) {
  if (value.user !== "1000:1000" || value.read_only !== true || value.init !== true || (networkMode !== undefined && value.network_mode !== networkMode)) throw new Error(`Compose ${label} runtime settings are unsafe`);
  if (label !== "maintenance" && (value.restart !== "unless-stopped" || value.stop_grace_period !== (label === "app" ? "45s" : "60s"))) throw new Error(`Compose ${label} lifecycle settings are unsafe`);
  array(value.tmpfs, [label === "app" ? "/tmp:size=32m,mode=1777" : "/tmp:size=64m,mode=1777"], `Compose ${label}.tmpfs`);
  array(value.security_opt, ["no-new-privileges:true"], `Compose ${label}.security_opt`);
  array(value.cap_drop, ["ALL"], `Compose ${label}.cap_drop`);
}

export function inspectComposeContract(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  const root = document.toJS({ mapAsMap: false });
  exactKeys(root, TOP_LEVEL_KEYS, "Compose document");
  if (root.name !== "perpay") throw new Error("Compose project name must retain the official template value");
  for (const [key, [, expected]] of Object.entries(TEMPLATE_EXTENSIONS)) {
    if (root[key] !== expected) throw new Error(`${key} must retain its anchored template value`);
  }
  try {
    exactKeys(root.services, new Set(["app", "backup", "maintenance"]), "Compose services");
  } catch (error) {
    throw new Error("Compose services must contain exactly the app, backup, and maintenance services", { cause: error });
  }
  exactKeys(root.volumes, new Set(["perpay-data", "perpay-backups", "perpay-secrets"]), "Compose volumes");
  for (const name of ["perpay-data", "perpay-backups", "perpay-secrets"]) {
    if (root.volumes[name] !== null && (typeof root.volumes[name] !== "object" || Object.keys(root.volumes[name]).length !== 0)) throw new Error(`Compose ${name} must be a local managed volume`);
  }

  const app = root.services.app;
  exactKeys(app, APP_KEYS, "Compose app service");
  serviceEnvironment(app.environment, { PERPAY_SECRETS_DIR: "/run/perpay-secrets", PERPAY_PUBLIC_URL: "https://pay.example.com", PERPAY_TRUSTED_PROXY_CIDRS: "" }, "Compose app.environment");
  alias(document, ["services", "app", "ports", 0], "perpay-host-port", "app.ports[0]");
  alias(document, ["services", "app", "environment", "PERPAY_PUBLIC_URL"], "perpay-public-url", "app.environment.PERPAY_PUBLIC_URL");
  alias(document, ["services", "app", "environment", "PERPAY_TRUSTED_PROXY_CIDRS"], "perpay-trusted-proxy-cidrs", "app.environment.PERPAY_TRUSTED_PROXY_CIDRS");
  array(app.ports, ["127.0.0.1:6190:6190"], "Compose app.ports");
  array(app.volumes, ["perpay-data:/data", "perpay-backups:/backups:ro", "perpay-secrets:/run/perpay-secrets"], "Compose app.volumes");
  checkCommon(app, "app");
  array(app.healthcheck.test, ["CMD", "node", "-e", "fetch('http://127.0.0.1:6190/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], "Compose app.healthcheck.test");
  if (app.healthcheck.interval !== "30s" || app.healthcheck.timeout !== "5s" || app.healthcheck.start_period !== "5m" || app.healthcheck.retries !== 3) throw new Error("Compose app healthcheck settings are unsafe");
  checkLogging(app.logging, "Compose app.logging");

  const backup = root.services.backup;
  exactKeys(backup, BACKUP_KEYS, "Compose backup service");
  serviceEnvironment(backup.environment, { PERPAY_DATA_DIR: "/data", PERPAY_BACKUP_DIR: "/backups" }, "Compose backup.environment");
  array(backup.volumes, ["perpay-data:/data:ro", "perpay-backups:/backups"], "Compose backup.volumes");
  array(backup.command, ["node", "dist/backup/runner.js", "schedule"], "Compose backup.command");
  if (JSON.stringify(backup.depends_on) !== JSON.stringify({ app: { condition: "service_healthy" } })) throw new Error("Compose backup must wait for the healthy app service");
  checkCommon(backup, "backup", "none");
  array(backup.healthcheck.test, ["CMD", "node", "dist/backup/runner.js", "health"], "Compose backup.healthcheck.test");
  if (backup.healthcheck.interval !== "5m" || backup.healthcheck.timeout !== "10s" || backup.healthcheck.start_period !== "10m" || backup.healthcheck.retries !== 3) throw new Error("Compose backup healthcheck settings are unsafe");
  checkLogging(backup.logging, "Compose backup.logging");

  const maintenance = root.services.maintenance;
  exactKeys(maintenance, MAINTENANCE_KEYS, "Compose maintenance service");
  array(maintenance.profiles, ["maintenance"], "Compose maintenance.profiles");
  serviceEnvironment(maintenance.environment, { PERPAY_DATA_DIR: "/data", PERPAY_BACKUP_DIR: "/backups" }, "Compose maintenance.environment");
  array(maintenance.volumes, ["perpay-data:/data", "perpay-backups:/backups"], "Compose maintenance.volumes");
  array(maintenance.entrypoint, ["node", "dist/backup/runner.js"], "Compose maintenance.entrypoint");
  checkCommon(maintenance, "maintenance", "none");

  const imageNodes = ["app", "backup", "maintenance"].map((service) => {
    const node = document.getIn(["services", service, "image"], true);
    if (!isScalar(node) || typeof node.value !== "string" || node.value.length === 0) throw new Error(`Compose ${service}.image must be a non-empty scalar string`);
    return node;
  });
  if (imageNodes.some((node) => node.value !== imageNodes[0].value)) throw new Error("Compose app, backup, and maintenance must use the same image reference");
  return Object.freeze({ document, imageNodes: Object.freeze(imageNodes), image: imageNodes[0].value });
}

export function replaceComposeImage(source, image) {
  if (typeof image !== "string" || image.length === 0) throw new TypeError("replacement image must be a non-empty string");
  const contract = inspectComposeContract(source);
  let rendered = source;
  for (const [start, end] of contract.imageNodes.map((node) => node.range).sort((left, right) => right[0] - left[0])) rendered = `${rendered.slice(0, start)}${image}${rendered.slice(end)}`;
  return rendered;
}
