import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnstileWidget } from "./TurnstileWidget";
import { resetTurnstileLoaderForTests, type TurnstileRenderOptions } from "./turnstile";

afterEach(() => {
  cleanup();
  delete window.turnstile;
  resetTurnstileLoaderForTests();
  vi.restoreAllMocks();
});

describe("TurnstileWidget", () => {
  it("renders with the given site key and forwards the token", async () => {
    const onToken = vi.fn();
    const renderWidget = vi.fn((_container: HTMLElement | string, options: TurnstileRenderOptions) => {
      options.callback?.("widget-ok");
      return "widget-1";
    });
    window.turnstile = {
      render: renderWidget,
      reset: vi.fn(),
      remove: vi.fn()
    };

    const view = render(<TurnstileWidget siteKey="1x00000000000000000000AA" onToken={onToken} />);
    await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(1));
    expect(renderWidget.mock.calls[0]![1]).toMatchObject({ sitekey: "1x00000000000000000000AA" });
    expect(onToken).toHaveBeenCalledWith("widget-ok");

    view.unmount();
    expect(window.turnstile.remove).toHaveBeenCalledWith("widget-1");
  });
});
