// `.test` is the smoke host (next.readinglite.test).

const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

export function httpsRedirect(url: string): Response | null {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== "http:" || isLocalDevHost(parsed.hostname)) return null;
  const location = `https://${parsed.host}${parsed.pathname}${parsed.search}`;
  return new Response(null, { status: 301, headers: { Location: location } });
}

export function strictTransportSecurity(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== "https:" || isLocalDevHost(parsed.hostname)) return null;
  return STRICT_TRANSPORT_SECURITY;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isLocalDevHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "localhost." || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".local.")) return true;
  if (host.endsWith(".test") || host.endsWith(".test.")) return true;
  return false;
}
