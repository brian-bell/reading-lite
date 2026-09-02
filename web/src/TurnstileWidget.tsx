import { useEffect, useRef } from "react";

import { loadTurnstileApi, type TurnstileApi } from "./turnstile";

export function TurnstileWidget({
  siteKey,
  onToken
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    onTokenRef.current(null);

    const mount = (api: TurnstileApi) => {
      if (cancelled || !containerRef.current) return;
      apiRef.current = api;
      widgetIdRef.current = api.render(containerRef.current, {
        sitekey: siteKey,
        theme: "light",
        callback: (token) => onTokenRef.current(token),
        "error-callback": () => onTokenRef.current(null),
        "expired-callback": () => onTokenRef.current(null),
        "timeout-callback": () => onTokenRef.current(null)
      });
    };

    if (window.turnstile) {
      mount(window.turnstile);
    } else {
      void loadTurnstileApi()
        .then(mount)
        .catch(() => {
          if (!cancelled) onTokenRef.current(null);
        });
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
