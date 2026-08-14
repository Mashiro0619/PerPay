import { isUtf8 } from "node:buffer";

export type StrictJsonErrorCode = "INVALID_UTF8" | "INVALID_JSON" | "DUPLICATE_KEY" | "TOO_DEEP";

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;

  constructor(code: StrictJsonErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

export function parseStrictJson(bytes: Uint8Array, maximumDepth = 64): unknown {
  if (!(bytes instanceof Uint8Array) || !isUtf8(bytes)) {
    throw new StrictJsonError("INVALID_UTF8", "JSON must use valid UTF-8");
  }
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new StrictJsonError("INVALID_JSON", "request body is not valid JSON", { cause: error });
  }
  new DuplicateKeyScanner(text, maximumDepth).scan();
  return value;
}

class DuplicateKeyScanner {
  readonly #text: string;
  readonly #maximumDepth: number;
  #index = 0;

  constructor(text: string, maximumDepth: number) {
    if (!Number.isInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 256) {
      throw new RangeError("maximum JSON depth must be an integer from 1 to 256");
    }
    this.#text = text;
    this.#maximumDepth = maximumDepth;
  }

  scan(): void {
    this.#skipWhitespace();
    this.#scanValue(1);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) {
      throw new StrictJsonError("INVALID_JSON", "JSON contains trailing data");
    }
  }

  #scanValue(depth: number): void {
    if (depth > this.#maximumDepth) {
      throw new StrictJsonError("TOO_DEEP", "JSON exceeds the maximum nesting depth");
    }
    const character = this.#text[this.#index];
    if (character === "{") {
      this.#scanObject(depth);
      return;
    }
    if (character === "[") {
      this.#scanArray(depth);
      return;
    }
    if (character === '"') {
      this.#scanString();
      return;
    }
    this.#scanPrimitive();
  }

  #scanObject(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return;
    }

    const keys = new Set<string>();
    while (true) {
      const key = this.#scanString();
      if (keys.has(key)) {
        throw new StrictJsonError("DUPLICATE_KEY", `JSON object contains duplicate key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.#skipWhitespace();
      this.#index += 1; // JSON.parse already proved this character is ':'.
      this.#skipWhitespace();
      this.#scanValue(depth + 1);
      this.#skipWhitespace();
      if (this.#text[this.#index] === "}") {
        this.#index += 1;
        return;
      }
      this.#index += 1; // JSON.parse already proved this character is ','.
      this.#skipWhitespace();
    }
  }

  #scanArray(depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    while (true) {
      this.#scanValue(depth + 1);
      this.#skipWhitespace();
      if (this.#text[this.#index] === "]") {
        this.#index += 1;
        return;
      }
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #scanString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index] ?? "";
      if (character === "\\") {
        this.#index += 2;
        continue;
      }
      this.#index += 1;
      if (character === '"') {
        return JSON.parse(this.#text.slice(start, this.#index)) as string;
      }
    }
    throw new StrictJsonError("INVALID_JSON", "JSON string is not terminated");
  }

  #scanPrimitive(): void {
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index] ?? "";
      if (character === "," || character === "]" || character === "}" || isJsonWhitespace(character)) {
        return;
      }
      this.#index += 1;
    }
  }

  #skipWhitespace(): void {
    while (this.#index < this.#text.length && isJsonWhitespace(this.#text[this.#index] ?? "")) {
      this.#index += 1;
    }
  }
}

function isJsonWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}
