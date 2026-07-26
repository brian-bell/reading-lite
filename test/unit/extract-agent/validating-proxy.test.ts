import { createServer, request } from "node:http";
import { connect, createServer as createNetServer, Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startValidatingProxy,
  type ProxyDial,
  type ValidatingProxy,
} from "../../../scripts/extract-agent-lib/validating-proxy";

const open: Array<{ close(): Promise<void> | void }> = [];
const DUAL_STACK_ADDRESSES = [
  { address: "2001:4860:4860::8888", family: 6 },
  { address: "93.184.216.34", family: 4 },
];

afterEach(async () => {
  await Promise.allSettled(open.splice(0).reverse().map((resource) => resource.close()));
});

describe("startValidatingProxy", () => {
  it("forwards plain HTTP through the vetted IP without resolving again", async () => {
    const fixture = createServer((req, res) => {
      expect(req.url).toBe("/article?view=full");
      expect(req.headers.host).toBe("public.example");
      res.writeHead(201, { "content-type": "text/plain" });
      res.end("article body");
    });
    const fixturePort = await listen(fixture);
    open.push({ close: () => closeServer(fixture) });

    const dial = vi.fn<ProxyDial>(() =>
      connect({ host: "127.0.0.1", port: fixturePort }) as Socket,
    );
    const proxy = await startValidatingProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dial,
    });
    open.push(proxy);

    const response = await proxyRequest(proxy, "http://public.example/article?view=full");

    expect(response).toEqual({ status: 201, body: "article body", location: undefined });
    expect(dial).toHaveBeenCalledWith({ address: "93.184.216.34", port: 80, family: 4 });
  });

  it("tries the next vetted address when the first plain-HTTP connection fails", async () => {
    const fixture = createServer((_req, res) => res.end("reachable over IPv4"));
    const fixturePort = await listen(fixture);
    open.push({ close: () => closeServer(fixture) });
    const dial = fallbackDial(fixturePort);
    const proxy = await startValidatingProxy({
      lookup: async () => DUAL_STACK_ADDRESSES,
      dial,
    });
    open.push(proxy);

    const response = await proxyRequest(proxy, "http://dual-stack.example/article");

    expect(response).toMatchObject({ status: 200, body: "reachable over IPv4" });
    expect(dial.mock.calls.map(([destination]) => destination.address)).toEqual([
      "2001:4860:4860::8888",
      "93.184.216.34",
    ]);
  });

  it("refuses a redirect hop into private space before dialing it", async () => {
    const fixture = createServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/admin" });
      res.end();
    });
    const fixturePort = await listen(fixture);
    open.push({ close: () => closeServer(fixture) });
    const dial = vi.fn<ProxyDial>(() => connect({ host: "127.0.0.1", port: fixturePort }));
    const proxy = await startValidatingProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dial,
    });
    open.push(proxy);

    const first = await proxyRequest(proxy, "http://public.example/start");
    expect(first.location).toBe("http://127.0.0.1/admin");

    const second = await proxyRequest(proxy, first.location!);

    expect(second.status).toBe(403);
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it("opens a CONNECT tunnel only through the vetted IP", async () => {
    const fixture = createNetServer((socket) => socket.pipe(socket));
    const fixturePort = await listenNet(fixture);
    open.push({ close: () => closeNetServer(fixture) });
    const dial = vi.fn<ProxyDial>(() => connect({ host: "127.0.0.1", port: fixturePort }));
    const proxy = await startValidatingProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dial,
    });
    open.push(proxy);

    const socket = await connectToProxy(proxy);
    socket.write("CONNECT secure.example:443 HTTP/1.1\r\nHost: secure.example:443\r\n\r\n");
    const responseHead = await readHttpHead(socket);

    expect(responseHead).toContain("200 Connection Established");
    expect(dial).toHaveBeenCalledWith({ address: "93.184.216.34", port: 443, family: 4 });

    const echoed = once(socket, "data");
    socket.write("opaque tls bytes");
    const [data] = await echoed as [Buffer];
    expect(data.toString("utf8")).toBe("opaque tls bytes");
    socket.destroy();
  });

  it("tries the next vetted address before acknowledging a CONNECT tunnel", async () => {
    const fixture = createNetServer((socket) => socket.pipe(socket));
    const fixturePort = await listenNet(fixture);
    open.push({ close: () => closeNetServer(fixture) });
    const dial = fallbackDial(fixturePort);
    const proxy = await startValidatingProxy({
      lookup: async () => DUAL_STACK_ADDRESSES,
      dial,
    });
    open.push(proxy);

    const socket = await connectToProxy(proxy);
    socket.write("CONNECT secure.example:443 HTTP/1.1\r\nHost: secure.example:443\r\n\r\n");
    const responseHead = await readHttpHead(socket);

    expect(responseHead).toContain("200 Connection Established");
    expect(dial.mock.calls.map(([destination]) => destination.address)).toEqual(
      DUAL_STACK_ADDRESSES.map(({ address }) => address),
    );
    socket.destroy();
  });

  it("refuses a private CONNECT target without dialing it", async () => {
    const dial = vi.fn<ProxyDial>();
    const proxy = await startValidatingProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dial,
    });
    open.push(proxy);

    const socket = await connectToProxy(proxy);
    socket.write("CONNECT 192.168.1.1:443 HTTP/1.1\r\nHost: 192.168.1.1:443\r\n\r\n");
    const responseHead = await readHttpHead(socket);

    expect(responseHead).toContain("403 Forbidden");
    expect(dial).not.toHaveBeenCalled();
    socket.destroy();
  });

  it("tries the next vetted address before forwarding a WebSocket Upgrade", async () => {
    const fixture = createServer();
    fixture.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
    const fixturePort = await listen(fixture);
    open.push({ close: () => closeServer(fixture) });
    const dial = fallbackDial(fixturePort);
    const proxy = await startValidatingProxy({
      lookup: async () => DUAL_STACK_ADDRESSES,
      dial,
    });
    open.push(proxy);

    const socket = await connectToProxy(proxy);
    socket.write(
      "GET ws://live.example/chat HTTP/1.1\r\n" +
      "Host: live.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    const responseHead = await readHttpHead(socket);

    expect(responseHead).toContain("101 Switching Protocols");
    expect(dial.mock.calls.map(([destination]) => destination.address)).toEqual(
      DUAL_STACK_ADDRESSES.map(({ address }) => address),
    );
    socket.destroy();
  });

  it("refuses a CONNECT hostname when any DNS answer is private", async () => {
    const dial = vi.fn<ProxyDial>();
    const proxy = await startValidatingProxy({
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
      dial,
    });
    open.push(proxy);

    const socket = await connectToProxy(proxy);
    socket.write("CONNECT mixed.example:443 HTTP/1.1\r\nHost: mixed.example:443\r\n\r\n");
    const responseHead = await readHttpHead(socket);

    expect(responseHead).toContain("403 Forbidden");
    expect(dial).not.toHaveBeenCalled();
    socket.destroy();
  });

  it("forwards a plain WebSocket Upgrade through the vetted IP", async () => {
    const fixture = createServer();
    fixture.on("upgrade", (req, socket) => {
      expect(req.url).toBe("/chat?room=reading");
      expect(req.headers.host).toBe("live.example");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      socket.pipe(socket);
    });
    const fixturePort = await listen(fixture);
    open.push({ close: () => closeServer(fixture) });
    const dial = vi.fn<ProxyDial>(() => connect({ host: "127.0.0.1", port: fixturePort }));
    const proxy = await startValidatingProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dial,
    });
    open.push(proxy);

    const socket = await connectToProxy(proxy);
    socket.write(
      "GET ws://live.example/chat?room=reading HTTP/1.1\r\n" +
      "Host: live.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    const responseHead = await readHttpHead(socket);

    expect(responseHead).toContain("101 Switching Protocols");
    expect(dial).toHaveBeenCalledWith({ address: "93.184.216.34", port: 80, family: 4 });

    const echoed = once(socket, "data");
    socket.write("websocket frame");
    const [data] = await echoed as [Buffer];
    expect(data.toString("utf8")).toBe("websocket frame");
    socket.destroy();
  });

  it("does not dial when shutdown wins a deferred DNS lookup", async () => {
    let resolveLookup!: (addresses: Array<{ address: string; family: number }>) => void;
    const lookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>((resolve) => {
      resolveLookup = resolve;
    }));
    const dial = vi.fn<ProxyDial>();
    const proxy = await startValidatingProxy({ lookup, dial });
    open.push(proxy);

    const pending = proxyRequest(proxy, "http://slow.example/article").catch((error: unknown) => error);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());

    await proxy.close();
    resolveLookup([{ address: "93.184.216.34", family: 4 }]);
    await pending;

    expect(dial).not.toHaveBeenCalled();
  });

  it("does not dial when the render deadline aborts a deferred DNS lookup", async () => {
    let resolveLookup!: (addresses: Array<{ address: string; family: number }>) => void;
    const lookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>((resolve) => {
      resolveLookup = resolve;
    }));
    const dial = vi.fn<ProxyDial>();
    const controller = new AbortController();
    const proxy = await startValidatingProxy({ lookup, dial, signal: controller.signal });
    open.push(proxy);

    const pending = proxyRequest(proxy, "http://slow.example/article").catch((error: unknown) => error);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());

    controller.abort();
    resolveLookup([{ address: "93.184.216.34", family: 4 }]);
    await pending;

    expect(dial).not.toHaveBeenCalled();
  });

  it("destroys an open CONNECT tunnel during proxy shutdown", async () => {
    const fixture = createNetServer((socket) => socket.on("data", () => {}));
    const fixturePort = await listenNet(fixture);
    open.push({ close: () => closeNetServer(fixture) });
    const proxy = await startValidatingProxy({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dial: () => connect({ host: "127.0.0.1", port: fixturePort }),
    });
    open.push(proxy);
    const socket = await connectToProxy(proxy);
    socket.write("CONNECT secure.example:443 HTTP/1.1\r\nHost: secure.example:443\r\n\r\n");
    await readHttpHead(socket);
    const closed = once(socket, "close");

    await proxy.close();

    await closed;
    expect(socket.destroyed).toBe(true);
  });
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listenNet(server: ReturnType<typeof createNetServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return address.port;
}

async function closeNetServer(server: ReturnType<typeof createNetServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function connectToProxy(proxy: ValidatingProxy): Promise<Socket> {
  const url = new URL(proxy.url);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  await once(socket, "connect");
  return socket;
}

async function readHttpHead(socket: Socket): Promise<string> {
  let received = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      cleanup();
      resolve(received.subarray(0, end + 4).toString("latin1"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before HTTP headers completed"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function proxyRequest(
  proxy: ValidatingProxy,
  target: string,
): Promise<{ status: number; body: string; location: string | undefined }> {
  const proxyUrl = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      method: "GET",
      path: target,
      headers: { host: new URL(target).host },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        location: res.headers.location,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function fallbackDial(fixturePort: number) {
  return vi.fn<ProxyDial>((destination) => {
    if (destination.family === 6) {
      const socket = new Socket();
      queueMicrotask(() => socket.emit("error", new Error("connect ENETUNREACH")));
      return socket;
    }
    return connect({ host: "127.0.0.1", port: fixturePort });
  });
}
