// A HYPERDRIVE binding whose control-plane reads are answered in memory, for
// Node-pool tests that construct a Durable Object guard directly. The guards
// read policy and limits through their own PostgreSQL client (withControlPlane
// in src/control-plane/db.ts); these tests used to hand them a fake D1.
//
// Each fake binding names its own sentinel host. A pg.Client for that host
// never connects: its statements go to the binding's responder. Clients for any
// other host (the real test database) are untouched, so a file can mix fakes
// with rolled-back real queries, and two guards can hold different fakes.
import pg from "pg";

export type FakeAnswer = Record<string, unknown> | null | Error;

const responders = new Map<string, (text: string) => FakeAnswer>();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const proto = pg.Client.prototype as unknown as Record<string, (...args: unknown[]) => unknown> & { host?: string };
  const { connect, query, end } = proto;
  const responderFor = (client: { host?: string }) => (client.host ? responders.get(client.host) : undefined);
  proto.connect = function (this: { host?: string }, ...args: unknown[]) {
    return responderFor(this) ? Promise.resolve() : connect!.apply(this, args);
  };
  proto.end = function (this: { host?: string }, ...args: unknown[]) {
    return responderFor(this) ? Promise.resolve() : end!.apply(this, args);
  };
  proto.query = function (this: { host?: string }, ...args: unknown[]) {
    const respond = responderFor(this);
    if (!respond) return query!.apply(this, args);
    const first = args[0] as string | { text?: string };
    const answer = respond(typeof first === "string" ? first : (first?.text ?? ""));
    if (answer instanceof Error) return Promise.reject(answer);
    const rows = answer === null ? [] : [answer];
    return Promise.resolve({ rows, rowCount: rows.length });
  };
}

// Every statement on this binding is answered by `answer` (evaluated per
// statement): a row, no row, or a thrown error.
export function fakeHyperdrive(answer: FakeAnswer | ((text: string) => FakeAnswer)): Hyperdrive {
  install();
  const host = `fake-${crypto.randomUUID()}.invalid`;
  responders.set(host, typeof answer === "function" ? answer : () => answer);
  return { connectionString: `postgres://fake:fake@${host}:5432/fake` } as Hyperdrive;
}
