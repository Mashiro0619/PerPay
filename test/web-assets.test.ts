import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import {
  WEB_ASSET_PATHS,
  WEB_ASSET_URLS,
  webAsset,
} from "../src/http/web/assets.ts";

describe("web asset manifest", () => {
  it("binds every immutable URL to the complete SHA-256 digest of its content", () => {
    assert.equal(WEB_ASSET_PATHS.length, 6);
    assert.equal(new Set(WEB_ASSET_PATHS).size, WEB_ASSET_PATHS.length);

    for (const path of Object.values(WEB_ASSET_URLS)) {
      const match = /^\/assets\/(?:app|vendor\/usuzumi)\/([0-9a-f]{64})\/[^/]+$/.exec(path);
      assert.ok(match, `asset path is not content addressed: ${path}`);
      const asset = webAsset(path);
      assert.ok(asset);
      assert.equal(
        match[1],
        createHash("sha256").update(asset.body, "utf8").digest("hex"),
      );
    }
  });

  it("does not serve the former version-only immutable paths", () => {
    assert.equal(webAsset("/assets/app/v0.1.0/admin.js"), null);
    assert.equal(webAsset("/assets/vendor/usuzumi/2.3.0/usuzumi.min.css"), null);
  });

  it("exposes the advanced checkout settings form through the admin asset", () => {
    const adminScript = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.ok(adminScript);
    assert.match(adminScript, /settings-advanced-form/);
    assert.match(adminScript, /\/settings\/advanced/);
    assert.match(adminScript, /checkout_key_rotation_days/);
    assert.match(adminScript, /checkout_terminal_observation_seconds/);
  });

  it("exposes the guided settings flow without asking for an application private key", () => {
    const adminScript = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.ok(adminScript);
    assert.match(adminScript, /GENERATE_APPLICATION_KEY/);
    assert.match(adminScript, /CONFIGURE_PROVIDER/);
    assert.match(adminScript, /CONFIGURE_COLLECTION/);
    assert.match(adminScript, /GENERATE_API_KEY/);
    assert.match(adminScript, /settings\/provider\/application-key\/actions\/generate/);
    assert.match(adminScript, /复制应用公钥/);
    assert.match(adminScript, /生成 API 密钥/);
    assert.match(adminScript, /ArrowRight/);
    assert.match(adminScript, /handleSettingsMutationError/);
    assert.doesNotMatch(adminScript, /settings-provider-private-key/);
    assert.doesNotMatch(adminScript, /首次配置必须填写应用私钥/);
  });

  it("creates real test-payment orders from completed settings", () => {
    const adminScript = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.ok(adminScript);
    assert.match(adminScript, /\/test-payments/);
    assert.match(adminScript, /test_payment_id/);
    assert.match(adminScript, /crypto\.randomUUID\(\)/);
    assert.match(adminScript, /这是实际到账测试/);
    assert.match(adminScript, /系统不会自动退款/);
    assert.match(adminScript, /最终应付金额/);
    assert.match(adminScript, /\/qr\.svg/);
    assert.match(adminScript, /pollTestPaymentOrder/);
    assert.match(adminScript, /TEST_PAYMENT_PENDING_STORAGE_KEY/);
    assert.match(adminScript, /继续上次测试/);
    assert.match(adminScript, /自动刷新已停止/);
    assert.doesNotMatch(adminScript, /模拟到账|模拟确认/);
  });

  it("removes test-payment instructions after a terminal status or unreliable polling", async () => {
    const adminScript = webAsset(WEB_ASSET_URLS.adminScript)?.body;
    assert.ok(adminScript);

    const confirmed = createAdminTestPaymentHarness(adminScript, () => testPaymentResponse({
      payment: { status: "CONFIRMED", received_amount_cents: 101 },
    }));
    let terminalObserved = false;
    confirmed.hooks.renderTestPaymentResult(
      testPaymentOrder(),
      confirmed.region,
      () => { terminalObserved = true; },
    );
    assertTestPaymentInstructions(confirmed.region, true);
    await confirmed.runNextTimer();
    assert.equal(terminalObserved, true);
    assertTestPaymentInstructions(confirmed.region, false);

    const unavailable = createAdminTestPaymentHarness(
      adminScript,
      () => new Response(JSON.stringify({ error: { code: "internal_error", message: "failed" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    unavailable.hooks.renderTestPaymentResult(
      testPaymentOrder(),
      unavailable.region,
      () => assert.fail("polling failures must not mark the order terminal"),
    );
    assertTestPaymentInstructions(unavailable.region, true);
    await unavailable.runNextTimer();
    await unavailable.runNextTimer();
    await unavailable.runNextTimer();
    assertTestPaymentInstructions(unavailable.region, false);
  });

  it("keeps a final not-found checkout inert across browser lifecycle events", () => {
    const checkoutScript = webAsset(WEB_ASSET_URLS.checkoutScript)?.body;
    assert.ok(checkoutScript);

    class FakeHTMLElement {
      readonly dataset: Record<string, string> = {
        checkoutApiUrl: "",
        checkoutQrUrl: "",
        initialState: "NOT_FOUND",
        refundStatus: "NONE",
        retryAfterSeconds: "",
      };

      querySelector(): null {
        return null;
      }
    }
    class FakeHTMLDialogElement extends FakeHTMLElement {}
    class FakeHTMLImageElement extends FakeHTMLElement {}
    class FakeHTMLTimeElement extends FakeHTMLElement {}
    class FakeHTMLAnchorElement extends FakeHTMLElement {}

    const root = new FakeHTMLElement();
    const documentListeners = new Map<string, () => void>();
    const windowListeners = new Map<string, () => void>();
    let fetchCount = 0;
    const document = {
      activeElement: null,
      hidden: false,
      title: "",
      querySelector(selector: string) {
        return selector === "[data-checkout-root]" ? root : null;
      },
      addEventListener(name: string, listener: () => void) {
        documentListeners.set(name, listener);
      },
    };
    const window = {
      location: { origin: "https://checkout.example.test" },
      addEventListener(name: string, listener: () => void) {
        windowListeners.set(name, listener);
      },
      setInterval() { return 1; },
      clearInterval() {},
      setTimeout() { return 1; },
      clearTimeout() {},
      requestAnimationFrame(callback: () => void) {
        callback();
        return 1;
      },
    };

    runInNewContext(checkoutScript, {
      AbortController,
      Date,
      HTMLAnchorElement: FakeHTMLAnchorElement,
      HTMLDialogElement: FakeHTMLDialogElement,
      HTMLElement: FakeHTMLElement,
      HTMLImageElement: FakeHTMLImageElement,
      HTMLTimeElement: FakeHTMLTimeElement,
      Math,
      Number,
      Object,
      Promise,
      String,
      URL,
      document,
      fetch() {
        fetchCount += 1;
        return new Promise(() => undefined);
      },
      navigator: { onLine: true },
      window,
    });

    documentListeners.get("visibilitychange")?.();
    windowListeners.get("online")?.();
    assert.equal(fetchCount, 0);
  });
});

interface AdminTestPaymentHooks {
  renderTestPaymentResult(
    order: Record<string, unknown>,
    region: FakeNode,
    onTerminal: () => void,
  ): void;
}

function createAdminTestPaymentHarness(
  adminScript: string,
  fetchResponse: () => Response,
): {
  hooks: AdminTestPaymentHooks;
  region: FakeNode;
  runNextTimer: () => Promise<void>;
} {
  const instrumented = adminScript.replace(
    /\}\)\(\);\s*$/,
    "  globalThis.__perpayAdminTestHooks = { renderTestPaymentResult };\n})();",
  );
  assert.notEqual(instrumented, adminScript, "admin test hooks were not injected");

  const timers: Array<() => void> = [];
  const body = new FakeNode("body");
  body.dataset.perpayAdminPage = "test";
  const sandbox: Record<string, unknown> = {
    AbortController,
    Headers,
    Node: FakeNode,
    Response,
    crypto,
    document: {
      body,
      cookie: "",
      createElement: (tag: string) => new FakeNode(tag),
      createTextNode: (text: string) => {
        const node = new FakeNode("#text");
        node.textContent = text;
        return node;
      },
    },
    fetch: async () => fetchResponse(),
    location: { pathname: "/admin/settings", search: "" },
    sessionStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    setTimeout(callback: () => void) {
      timers.push(callback);
      return timers.length;
    },
  };
  runInNewContext(instrumented, sandbox);
  const hooks = sandbox.__perpayAdminTestHooks as AdminTestPaymentHooks | undefined;
  assert.ok(hooks);

  return {
    hooks,
    region: new FakeNode("section"),
    async runNextTimer() {
      const timer = timers.shift();
      assert.ok(timer, "expected a pending test-payment poll");
      timer();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function testPaymentOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: "12345678-1234-4123-8123-123456789abc",
    merchant_order_no: "test-12345678-1234-4123-8123-123456789abc",
    payable_amount_cents: 101,
    currency: "CNY",
    checkout: {
      status: "OPEN",
      token: "pct1_test-payment-token",
      checkout_url: "https://pay.example.test/checkout/pct1_test-payment-token",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    payment: { status: "UNPAID", received_amount_cents: null },
    ...overrides,
  };
}

function testPaymentResponse(overrides: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data: testPaymentOrder(overrides) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function assertTestPaymentInstructions(region: FakeNode, visible: boolean): void {
  const nodes = descendants(region);
  const qrVisible = nodes.some((node) => node.tagName === "img");
  const checkoutVisible = nodes.some(
    (node) => node.tagName === "a" && node.textContent === "打开收银台",
  );
  assert.equal(qrVisible, visible);
  assert.equal(checkoutVisible, visible);
  assert.equal(
    nodes.some((node) => node.tagName === "a" && node.textContent === "查看订单"),
    true,
  );
}

function descendants(root: FakeNode): FakeNode[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classList: { add: (...tokens: string[]) => void; contains: (token: string) => boolean };
  parentNode: FakeNode | null = null;
  textContent = "";
  hidden = false;
  #classTokens = new Set<string>();

  constructor(tagName: string) {
    this.tagName = tagName;
    this.classList = {
      add: (...tokens) => tokens.forEach((token) => this.#classTokens.add(token)),
      contains: (token) => this.#classTokens.has(token),
    };
  }

  get className(): string {
    return [...this.#classTokens].join(" ");
  }

  set className(value: string) {
    this.#classTokens = new Set(value.split(/\s+/).filter(Boolean));
  }

  get isConnected(): boolean {
    return true;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children.splice(0, this.children.length);
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}
