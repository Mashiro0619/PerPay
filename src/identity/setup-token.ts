import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A startup capability whose plaintext is delivered only to the operator callback. */
export class SetupToken {
  #digest: Buffer | null;

  constructor(onIssued?: (token: string) => void) {
    const token = randomBytes(32).toString("hex");
    this.#digest = createHash("sha256").update(token, "ascii").digest();
    onIssued?.(token);
  }

  matches(token: string): boolean {
    if (this.#digest === null || !/^[0-9a-f]{64}$/.test(token)) return false;
    const digest = createHash("sha256").update(token, "ascii").digest();
    try {
      return timingSafeEqual(digest, this.#digest);
    } finally {
      digest.fill(0);
    }
  }

  consume(): void {
    this.#digest?.fill(0);
    this.#digest = null;
  }
}
