import { useEffect, useRef } from "react";

import { loadTurnstileApi, type TurnstileApi } from "./turnstile";

export function TurnstileWidget({
  siteKey,
  onToken,
  onError
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  onError?: (error: Error) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    onTokenRef.current(null);

    const mount = (api: TurnstileApi) => {
      if (cancelled || !containerRef.current) return;
      apiRef.current = api;
      const recycle = () => {
        onTokenRef.current(null);
        const widgetId = widgetIdRef.current;
        if (widgetId) api.reset(widgetId);
      };
      widgetIdRef.current = api.render(containerRef.current, {
        sitekey: siteKey,
        theme: "light",
        callback: (token) => onTokenRef.current(token),
        "error-callback": () => {
          // Auto-retry is the default. Reset here would stack retries and can
          // tight-loop on persistent client errors (invalid sitekey/domain).
          onTokenRef.current(null);
          return true;
        },
        "expired-callback": recycle,
        "timeout-callback": recycle
      });
    };

    const reportLoadError = (error: unknown) => {
      if (cancelled) return;
      onTokenRef.current(null);
      const next = error instanceof Error ? error : new Error("Turnstile failed to load");
      onErrorRef.current?.(next);
    };

    if (window.turnstile) {
      mount(window.turnstile);
    } else {
      void loadTurnstileApi().then(mount).catch(reportLoadError);
    }

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      const api = apiRef.current ?? window.turnstile;
      if (widgetId && api) api.remove(widgetId);
      widgetIdRef.current = null;
      apiRef.current = null;
    };
  }, [siteKey]);

  return (
    <div className="turnstile-widget" role="group" aria-label="Human check">
      <div ref={containerRef} />
    </div>
  );
}
