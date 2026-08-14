import type {
  AccountLogPage,
  AccountLogPageRequest,
  RawV3Response,
  SignedV3Request,
  V3Transport,
  V3TransportOptions,
} from "./types.ts";
import { AlipayProviderError } from "./errors.ts";
import type { LedgerProvider } from "./types.ts";

export type FakeTransportReply = RawV3Response | Error | ((request: SignedV3Request) => RawV3Response | Promise<RawV3Response>);

/**
 * Deterministic transport fake. It records signed requests and never opens a
 * socket, making accidental calls to a real endpoint impossible in tests.
 */
export class FakeV3Transport implements V3Transport {
  readonly requests: SignedV3Request[] = [];
  readonly options: V3TransportOptions[] = [];
  readonly #replies: FakeTransportReply[];

  constructor(replies: readonly FakeTransportReply[] = []) {
    this.#replies = [...replies];
  }

  enqueue(reply: FakeTransportReply): void {
    this.#replies.push(reply);
  }

  async request(request: SignedV3Request, options: V3TransportOptions): Promise<RawV3Response> {
    this.requests.push(request);
    this.options.push(options);
    const reply = this.#replies.shift();
    if (reply === undefined) {
      throw new AlipayProviderError({
        kind: "network",
        code: "transport_network",
        message: "fake transport has no queued response",
      });
    }
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? await reply(request) : reply;
  }
}

export interface FakeLedgerPageKey {
  readonly startTime: string;
  readonly endTime: string;
  readonly pageNo: number;
}

/**
 * In-memory provider for application-service tests. Pages are looked up by
 * their complete window and page number, so a test cannot accidentally reuse
 * a page from another account window.
 */
export class FakeLedgerProvider implements LedgerProvider {
  readonly calls: AccountLogPageRequest[] = [];
  readonly #pages = new Map<string, AccountLogPage>();
  readonly #errors = new Map<string, Error>();

  constructor(pages: readonly (FakeLedgerPageKey & { readonly page: AccountLogPage })[] = []) {
    for (const item of pages) this.#pages.set(pageKey(item), item.page);
  }

  addPage(key: FakeLedgerPageKey, page: AccountLogPage): this {
    this.#pages.set(pageKey(key), page);
    return this;
  }

  failPage(key: FakeLedgerPageKey, error: Error): this {
    this.#errors.set(pageKey(key), error);
    return this;
  }

  async queryPage(input: AccountLogPageRequest): Promise<AccountLogPage> {
    this.calls.push(input);
    const key = pageKey(input);
    const error = this.#errors.get(key);
    if (error) throw error;
    const page = this.#pages.get(key);
    if (!page) {
      throw new AlipayProviderError({
        kind: "invalid_response",
        code: "pagination_invalid",
        message: "fake provider page was not configured",
      });
    }
    return page;
  }
}

function pageKey(value: FakeLedgerPageKey): string {
  return `${value.startTime}\u0000${value.endTime}\u0000${value.pageNo}`;
}
