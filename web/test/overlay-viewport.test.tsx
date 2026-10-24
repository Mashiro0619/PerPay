import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOverlayViewport } from "../src/hooks/use-overlay-viewport";
import { useIsMobile } from "../src/hooks/use-mobile";
import { useCompactList } from "../src/hooks/use-compact-list";
import { mobileMedia } from "./mobile-media";

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

describe("shared compact breakpoint", () => {
  it("keeps landscape phones in drawer mode and changes both hooks at 1024px", () => {
    const media = mobileMedia(844, { coarse: true });
    const { result } = renderHook(() => [useIsMobile(), useCompactList()]);
    expect(result.current).toEqual([true, true]);
    media.resize(1024);
    expect(result.current).toEqual([false, false]);
    expect(matchMedia("(pointer: coarse)").matches).toBe(true);
  });

  it("trusts the CSS media result when overflow has expanded innerWidth", () => {
    vi.stubGlobal("innerWidth", 1202);
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { result } = renderHook(() => [useIsMobile(), useCompactList()]);
    expect(result.current).toEqual([true, true]);
  });
});
