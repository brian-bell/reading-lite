/**
 * Cloudflare Turnstile client loader for the login widget.
 *
 * Explicit render (`?render=explicit`) is the SPA path: LoginPage mounts the
 * widget only after GET /api/auth/login-options returns a non-null site key.
 * The site key is never read from Vite env.
 */

export const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type TurnstileRenderOptions = {
  sitekey: string;
  theme?: "light" | "dark" | "auto";
  appearance?: "always" | "execute" | "interaction-only";
  callback?: (token: string) => void;
  "error-callback"?: (errorCode?: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
};

export type TurnstileApi = {
  render: (container: HTMLElement | string, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
  getResponse?: (widgetId: string) => string | undefined;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loadPromise: Promise<TurnstileApi> | null = null;

function existingScript(): HTMLScriptElement | null {
  return document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
}

export function loadTurnstileApi(): Promise<TurnstileApi> {
  if (typeof window !== "undefined" && window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const finish = () => {
      if (window.turnstile) {
        resolve(window.turnstile);
        return;
      }
      loadPromise = null;
      reject(new Error("Turnstile failed to load"));
    };
    const fail = () => {
      loadPromise = null;
      reject(new Error("Turnstile failed to load"));
    };

    const already = existingScript();
    if (already) {
      already.addEventListener("load", finish);
      already.addEventListener("error", fail);
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", finish);
    script.addEventListener("error", fail);
    document.head.appendChild(script);
  });

  return loadPromise;
}

export function resetTurnstileLoaderForTests(): void {
  loadPromise = null;
  for (const script of Array.from(document.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_SRC}"]`))) {
    script.remove();
  }
}

export function parseTurnstileSiteKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
