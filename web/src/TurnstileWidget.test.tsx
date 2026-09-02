import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnstileWidget } from "./TurnstileWidget";
import { resetTurnstileLoaderForTests, TURNSTILE_SCRIPT_SRC, type TurnstileRenderOptions } from "./turnstile";

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

  it("reports a load error when the Turnstile script fails", async () => {
    const onToken = vi.fn();
    const onError = vi.fn();
    render(<TurnstileWidget siteKey="1x00000000000000000000AA" onToken={onToken} onError={onError} />);
    const script = await waitFor(() => {
      const el = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
      expect(el).toBeInstanceOf(HTMLScriptElement);
      return el as HTMLScriptElement;
    });
    script.dispatchEvent(new Event("error"));
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Turnstile failed to load" }));
    });
    expect(onToken).toHaveBeenCalledWith(null);
  });

  it("resets the widget when the challenge expires or times out, but not on error", async () => {
    const onToken = vi.fn();
    const onError = vi.fn();
    const reset = vi.fn();
    const renderWidget = vi.fn((_container: HTMLElement | string, options: TurnstileRenderOptions) => {
      options.callback?.("widget-ok");
      return "widget-1";
    });
    window.turnstile = {
      render: renderWidget,
      reset,
      remove: vi.fn()
    };

    render(<TurnstileWidget siteKey="1x00000000000000000000AA" onToken={onToken} onError={onError} />);
    await waitFor(() => expect(renderWidget).toHaveBeenCalledTimes(1));
    const options = renderWidget.mock.calls[0]![1];

    onToken.mockClear();
    expect(options["error-callback"]?.("110200")).toBe(true);
    expect(onToken).toHaveBeenCalledWith(null);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Turnstile check failed (110200)" })
    );
    expect(reset).not.toHaveBeenCalled();

    options["expired-callback"]?.();
    options["timeout-callback"]?.();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledWith("widget-1");
  });
});
