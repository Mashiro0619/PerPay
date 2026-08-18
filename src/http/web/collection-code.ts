import { renderSVG } from "uqr";

import { MAX_COLLECTION_CODE_PAYLOAD_BYTES } from "../../orders/collection-profile.ts";

export class CollectionCodeRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CollectionCodeRenderError";
  }
}

export class CollectionCodeSvgCache {
  readonly #entries = new Map<string, string>();
  readonly #maxEntries: number;
  readonly #renderer: (payload: string) => string;

  constructor(
    maxEntries = 8,
    renderer: (payload: string) => string = renderCollectionCodeSvg,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) {
      throw new RangeError("collection code cache size is invalid");
    }
    this.#maxEntries = maxEntries;
    this.#renderer = renderer;
  }

  render(payload: string): string {
    const cached = this.#entries.get(payload);
    if (cached !== undefined) {
      this.#entries.delete(payload);
      this.#entries.set(payload, cached);
      return cached;
    }

    const svg = this.#renderer(payload);
    this.#entries.set(payload, svg);
    if (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    return svg;
  }
}

export function renderCollectionCodeSvg(payload: string): string {
  if (
    !payload.isWellFormed() ||
    Buffer.byteLength(payload, "utf8") > MAX_COLLECTION_CODE_PAYLOAD_BYTES
  ) {
    throw new CollectionCodeRenderError("collection code payload exceeds the supported QR capacity");
  }

  try {
    return renderSVG(payload, {
      ecc: "M",
      boostEcc: true,
      border: 4,
      pixelSize: 8,
      blackColor: "#2f2f2c",
      whiteColor: "#ffffff",
    });
  } catch (error) {
    throw new CollectionCodeRenderError("collection code QR generation failed", { cause: error });
  }
}
