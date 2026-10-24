import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { siteEditorKey, siteEditorQueryOptions } from "../src/lib/site-editor-query";
import { json } from "./fixtures";

describe("site editor identity", () => {
  it.each([
    { client_id: "another-site", deleted_at: null },
    { client_id: "a", deleted_at: "2026-10-20T00:00:00Z" },
  ])("rejects a mismatched or deleted editor response: %j", async data => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data })));
    await expect(queryClient.fetchQuery(siteEditorQueryOptions("a")))
      .rejects.toThrow("网站身份不匹配");
    expect(queryClient.getQueryData(siteEditorKey("a"))).toBeUndefined();
  });
});
