/**
 * Cloudflare Turnstile client loader for the login widget.
 *
 * Explicit render (`?render=explicit`) is the SPA path: LoginPage mounts the
 * widget only after GET /api/auth/login-options returns a non-null site key.
 * The site key is never read from Vite env.
 *
 * A failed script is removed so a later remount injects a fresh tag. Reusing a
 * tag whose load/error already fired would hang (listeners never run again).
 */

export const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type TurnstileRenderOptions = {
  sitekey: string;
  theme?: "light" | "dark" | "auto";
  appearance?: "always" | "execute" | "interaction-only";
  callback?: (token: string) => void;
  "error-callback"?: (errorCode?: string) => boolean | void;
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

function removeTurnstileScripts(): void {
  for (const script of Array.from(document.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_SRC}"]`))) {
    script.remove();
  }
}

export function loadTurnstileApi(): Promise<TurnstileApi> {
  if (typeof window !== "undefined" && window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (loadPromise) return loadPromise;

  // Drop leftover tags from a failed or incomplete load. Their load/error
  // already fired, so attaching new listeners would hang.
  removeTurnstileScripts();

  loadPromise = new Promise<TurnstileApi>((resolve, reject) => {
    let settled = false;
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;

    const fail = () => {
      if (settled) return;
      settled = true;
      script.remove();
      loadPromise = null;
      reject(new Error("Turnstile failed to load"));
    };
    const finish = () => {
      if (settled) return;
      if (window.turnstile) {
        settled = true;
        resolve(window.turnstile);
        return;
      }
      fail();
    };

    script.addEventListener("load", finish);
    script.addEventListener("error", fail);
    document.head.appendChild(script);
  });

  return loadPromise;
}

export function resetTurnstileLoaderForTests(): void {
  loadPromise = null;
  removeTurnstileScripts();
}

export function parseTurnstileSiteKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
