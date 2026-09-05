import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_API_BASE, resolveApiTarget } from "../../../scripts/corpus-lib/config";

describe("resolveApiTarget production default", () => {
  const previousUrl = process.env.READER_URL;
  const previousToken = process.env.READER_API_TOKEN;

  afterEach(() => {
    if (previousUrl === undefined) delete process.env.READER_URL;
    else process.env.READER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.READER_API_TOKEN;
    else process.env.READER_API_TOKEN = previousToken;
  });

  it("defaults the API base to the canonical readinglite.ai origin", () => {
    delete process.env.READER_URL;
    expect(DEFAULT_API_BASE).toBe("https://readinglite.ai");
    expect(resolveApiTarget({}).base).toBe("https://readinglite.ai");
  });

  it("honors READER_URL then an explicit --url flag, stripping a trailing slash", () => {
    process.env.READER_URL = "https://reading-lite-staging.bbell.dev/";
    expect(resolveApiTarget({}).base).toBe("https://reading-lite-staging.bbell.dev");
    expect(resolveApiTarget({ url: "http://127.0.0.1:8787/" }).base).toBe("http://127.0.0.1:8787");
  });
});
