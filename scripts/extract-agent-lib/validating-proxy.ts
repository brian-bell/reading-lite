import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { BlockedHostError } from "../../src/modules/extractor";
import {
  resolveSafeDestination,
  type LookupFn,
  type ResolvedAddress,
} from "./safe-fetch";

export interface ProxyDestination extends ResolvedAddress {
  port: number;
}

export type ProxyDial = (destination: ProxyDestination) => Socket;

export interface ValidatingProxy {
  url: string;
  close(): Promise<void>;
}

export interface ValidatingProxyDeps {
  lookup: LookupFn;
  signal?: AbortSignal;
  dial?: ProxyDial;
}

export async function startValidatingProxy(deps: ValidatingProxyDeps): Promise<ValidatingProxy> {
  const internalAbort = new AbortController();
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, internalAbort.signal])
    : internalAbort.signal;
  const dial = deps.dial ?? ((destination) =>
    netConnect({
      host: destination.address,
      port: destination.port,
      family: destination.family,
    }));
  const sockets = new Set<Socket>();
  let active = true;
  let closePromise: Promise<void> | undefined;

  const track = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const forwardDeps: ForwardDeps = {
    lookup: deps.lookup,
    signal,
    dial: (destination) => track(dial(destination)),
    isActive: () => active,
  };
  const server = createServer((req, res) => {
    void forwardHttp(req.url ?? "", req.method ?? "GET", req.headers, req, res, forwardDeps);
  });
  server.on("connect", (req, client, head) => {
    void openConnectTunnel(req.url ?? "", client, head, forwardDeps);
  });
  server.on("upgrade", (req, client, head) => {
    void openUpgrade(
      req.url ?? "",
      req.method ?? "GET",
      req.httpVersion,
      req.rawHeaders,
      client,
      head,
      forwardDeps,
    );
  });
  server.on("connection", (socket) => track(socket));
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("validating proxy did not receive a TCP listen address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        active = false;
        internalAbort.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closePromise;
    },
  };
}

interface ForwardDeps {
  lookup: LookupFn;
  signal: AbortSignal;
  dial: ProxyDial;
  isActive(): boolean;
}

async function forwardHttp(
  rawTarget: string,
  method: string,
  incomingHeaders: IncomingHttpHeaders,
  body: NodeJS.ReadableStream,
  response: ServerResponse,
  deps: ForwardDeps,
): Promise<void> {
  let target: URL;
  try {
    target = parseHttpTarget(rawTarget);
  } catch {
    return sendError(response, 403, "Forbidden");
  }

  let selected: ResolvedAddress;
  try {
    const addresses = await resolveSafeDestination(target.href, deps.lookup, deps.signal);
    if (!deps.isActive() || deps.signal.aborted) {
      response.destroy();
      return;
    }
    selected = addresses[0]!;
  } catch (error) {
    if (!deps.isActive() || deps.signal.aborted) {
      response.destroy();
      return;
    }
    const status = error instanceof BlockedHostError ? 403 : 502;
    return sendError(response, status, status === 403 ? "Forbidden" : "Bad Gateway");
  }

  const port = target.port ? Number(target.port) : 80;
  const headers = sanitizeHeaders(incomingHeaders);
  headers.host = target.host;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => deps.dial({ ...selected, port });
  const upstream = httpRequest({
    hostname: selected.address,
    port,
    method,
    path: `${target.pathname}${target.search}`,
    headers,
    agent,
  }, (upstreamResponse) => {
    if (response.destroyed) {
      upstreamResponse.destroy();
      return;
    }
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      sanitizeHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) sendError(response, 502, "Bad Gateway");
    else response.destroy();
  });
  body.pipe(upstream);
}

async function openConnectTunnel(
  authority: string,
  client: Duplex,
  head: Buffer,
  deps: ForwardDeps,
): Promise<void> {
  let target: { url: URL; port: number };
  try {
    target = parseConnectTarget(authority);
  } catch {
    return sendSocketError(client, 403, "Forbidden");
  }

  let selected: ResolvedAddress;
  try {
    const addresses = await resolveSafeDestination(target.url.href, deps.lookup, deps.signal);
    if (!deps.isActive() || deps.signal.aborted) {
      client.destroy();
      return;
    }
    selected = addresses[0]!;
  } catch (error) {
    if (!deps.isActive() || deps.signal.aborted) {
      client.destroy();
      return;
    }
    const status = error instanceof BlockedHostError ? 403 : 502;
    return sendSocketError(client, status, status === 403 ? "Forbidden" : "Bad Gateway");
  }

  let upstream: Socket;
  try {
    upstream = deps.dial({ ...selected, port: target.port });
  } catch {
    return sendSocketError(client, 502, "Bad Gateway");
  }
  const fail = () => {
    if (!client.destroyed) sendSocketError(client, 502, "Bad Gateway");
  };
  upstream.once("error", fail);
  client.once("error", () => {
    upstream.destroy();
  });
  upstream.once("connect", () => {
    upstream.off("error", fail);
    upstream.on("error", () => {
      client.destroy();
    });
    if (!deps.isActive() || deps.signal.aborted || client.destroyed) {
      upstream.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

async function openUpgrade(
  rawTarget: string,
  method: string,
  httpVersion: string,
  rawHeaders: string[],
  client: Duplex,
  head: Buffer,
  deps: ForwardDeps,
): Promise<void> {
  let target: URL;
  try {
    target = parseUpgradeTarget(rawTarget);
  } catch {
    return sendSocketError(client, 403, "Forbidden");
  }
  const validationUrl = new URL(target.href);
  validationUrl.protocol = "http:";

  let selected: ResolvedAddress;
  try {
    const addresses = await resolveSafeDestination(validationUrl.href, deps.lookup, deps.signal);
    if (!deps.isActive() || deps.signal.aborted) {
      client.destroy();
      return;
    }
    selected = addresses[0]!;
  } catch (error) {
    if (!deps.isActive() || deps.signal.aborted) {
      client.destroy();
      return;
    }
    const status = error instanceof BlockedHostError ? 403 : 502;
    return sendSocketError(client, status, status === 403 ? "Forbidden" : "Bad Gateway");
  }

  const port = target.port ? Number(target.port) : 80;
  let upstream: Socket;
  try {
    upstream = deps.dial({ ...selected, port });
  } catch {
    return sendSocketError(client, 502, "Bad Gateway");
  }
  const fail = () => {
    if (!client.destroyed) sendSocketError(client, 502, "Bad Gateway");
  };
  upstream.once("error", fail);
  client.once("error", () => {
    upstream.destroy();
  });
  upstream.once("connect", () => {
    upstream.off("error", fail);
    upstream.on("error", () => {
      client.destroy();
    });
    if (!deps.isActive() || deps.signal.aborted || client.destroyed) {
      upstream.destroy();
      return;
    }
    const lines = [`${method} ${target.pathname}${target.search} HTTP/${httpVersion}`, `Host: ${target.host}`];
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i]!;
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "proxy-authorization" || lower === "proxy-connection") continue;
      lines.push(`${name}: ${rawHeaders[i + 1] ?? ""}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

function parseHttpTarget(raw: string): URL {
  if (hasUnsafeCharacters(raw)) throw new Error("unsafe request target");
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error("unsupported request target");
  }
  return parsed;
}

function parseUpgradeTarget(raw: string): URL {
  if (hasUnsafeCharacters(raw)) throw new Error("unsafe Upgrade target");
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "ws:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("unsupported Upgrade target");
  }
  return parsed;
}

function parseConnectTarget(raw: string): { url: URL; port: number } {
  if (hasUnsafeCharacters(raw) || /[/?#@]/.test(raw)) throw new Error("unsafe CONNECT target");
  const match = raw.match(/^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):([0-9]+)$/);
  if (!match) throw new Error("invalid CONNECT authority");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid CONNECT port");
  const url = new URL(`https://${match[1]}:${port}/`);
  if (!url.hostname) throw new Error("empty CONNECT host");
  return { url, port };
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sanitizeHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const sanitized = { ...headers };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_HEADERS, ...connectionTokens]) delete sanitized[name];
  return sanitized;
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  response.end(`${message}\n`);
}

function sendSocketError(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\n\r\n`,
  );
}

function hasUnsafeCharacters(value: string): boolean {
  return /[\u0000-\u0020\u007f]/.test(value);
}
