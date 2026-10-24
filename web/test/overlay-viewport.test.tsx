import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOverlayViewport } from "../src/hooks/use-overlay-viewport";

describe("visible overlay viewport", () => {
  it("follows the keyboard and panned visual viewport without a layout resize", () => {
    const viewport = Object.assign(new EventTarget(), { width: 360, height: 560, offsetTop: 0, offsetLeft: 0 });
    vi.stubGlobal("visualViewport", viewport);
    const remove = vi.spyOn(viewport, "removeEventListener");
    const { result, unmount } = renderHook(useOverlayViewport);
    expect(result.current).toMatchObject({ "--overlay-viewport-width": "360px", "--overlay-viewport-height": "560px" });
    act(() => {
      viewport.height = 248;
      viewport.offsetTop = 32;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toMatchObject({ "--overlay-viewport-height": "248px", "--overlay-viewport-top": "32px" });
    act(() => {
      viewport.width = 180;
      viewport.offsetLeft = 40;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(result.current).toMatchObject({ "--overlay-viewport-width": "180px", "--overlay-viewport-left": "40px" });
    unmount();
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("uses the layout viewport where the visual viewport API is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 664);
    const { result } = renderHook(useOverlayViewport);
    expect(result.current).toMatchObject({ "--overlay-viewport-width": "390px", "--overlay-viewport-height": "664px", "--overlay-viewport-top": "0px" });
  });
});
