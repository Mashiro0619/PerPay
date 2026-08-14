import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("requires an administrator password", () => {
    assert.throws(() => loadConfig({}), /PERPAY_ADMIN_PASSWORD/);
  });

  it("rejects placeholder passwords", () => {
    assert.throws(
      () => loadConfig({ PERPAY_ADMIN_PASSWORD: "CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD" }),
      /不能使用示例值/,
    );
  });

  it("normalizes valid configuration", () => {
    const config = loadConfig({
      PERPAY_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_HOST: "127.0.0.1",
      PERPAY_PORT: "19080",
      PERPAY_DATA_DIR: "./runtime-test",
      PERPAY_TIMEZONE: "Asia/Shanghai",
    });
    assert.equal(config.port, 19080);
    assert.equal(config.host, "127.0.0.1");
    assert.match(config.databasePath, /perpay\.sqlite3$/);
  });
});
