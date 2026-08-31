import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

/**
 * Keeps `docs/openapi.yaml` honest against the REST surface in `src/router.ts`.
 * MCP (`POST /mcp`, `POST /api/mcp`) is intentionally omitted — Streamable HTTP
 * MCP is not part of this OpenAPI document.
 */
const ROUTER_REST_PATHS = [
  "/health",
  "/api/whoami",
  "/api/auth/challenge",
  "/api/auth/redeem",
  "/api/auth/logout",
  "/api/readings",
  "/api/readings/import-markdown",
  "/api/readings/lookup",
  "/api/readings/similar",
  "/api/readings/{id}",
  "/api/readings/{id}/diagnostics",
  "/api/readings/{id}/reprocess",
  "/api/readings/{id}/content",
  "/api/readings/{id}/content/raw",
] as const;

const ROUTER_REST_OPERATIONS: ReadonlyArray<{ path: string; method: string }> = [
  { path: "/health", method: "get" },
  { path: "/api/whoami", method: "get" },
  { path: "/api/auth/challenge", method: "post" },
  { path: "/api/auth/redeem", method: "post" },
  { path: "/api/auth/logout", method: "post" },
  { path: "/api/readings", method: "get" },
  { path: "/api/readings", method: "post" },
  { path: "/api/readings/import-markdown", method: "post" },
  { path: "/api/readings/lookup", method: "get" },
  { path: "/api/readings/similar", method: "post" },
  { path: "/api/readings/{id}", method: "get" },
  { path: "/api/readings/{id}", method: "delete" },
  { path: "/api/readings/{id}/diagnostics", method: "get" },
  { path: "/api/readings/{id}/reprocess", method: "post" },
  { path: "/api/readings/{id}/content", method: "get" },
  { path: "/api/readings/{id}/content/raw", method: "get" },
];

const COOKIE_CSRF_OPERATIONS: ReadonlyArray<{ path: string; method: string }> = [
  { path: "/api/auth/logout", method: "post" },
  { path: "/api/readings", method: "post" },
  { path: "/api/readings/import-markdown", method: "post" },
  { path: "/api/readings/similar", method: "post" },
  { path: "/api/readings/{id}", method: "delete" },
  { path: "/api/readings/{id}/reprocess", method: "post" },
];

const REQUIRED_SCHEMAS = [
  "WhoamiResponse",
  "AuthChallengeBody",
  "AuthChallengeResponse",
  "AuthRedeemBody",
  "AuthRedeemResponse",
  "AuthLogoutResponse",
  "PostReadingsBody",
  "PostReadingsImportMarkdownBody",
  "PostReadingReprocessBody",
  "ListReadingsResponse",
  "Manifest",
  "ActivatedReading",
  "LookupResponse",
  "PostReadingsSimilarBody",
  "PostReadingsSimilarResponse",
  "DeleteReadingResponse",
  "GetReadingDiagnosticsResponse",
] as const;

type OpenApiDoc = {
  openapi: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; parameters?: Record<string, unknown> };
};

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const specPath = join(root, "docs/openapi.yaml");

function loadSpec(): OpenApiDoc {
  const raw = readFileSync(specPath, "utf8");
  return yaml.parse(raw) as OpenApiDoc;
}

describe("docs/openapi.yaml", () => {
  it("parses as OpenAPI 3.1 with every REST path and method from the router", () => {
    const doc = loadSpec();
    expect(doc.openapi).toMatch(/^3\.1\./);

    const paths = doc.paths ?? {};
    expect(Object.keys(paths).sort()).toEqual([...ROUTER_REST_PATHS].sort());

    for (const { path, method } of ROUTER_REST_OPERATIONS) {
      const item = paths[path];
      expect(item, `missing path ${path}`).toBeDefined();
      expect(item?.[method], `missing ${method.toUpperCase()} ${path}`).toBeDefined();
    }

    // MCP stays out of this document.
    expect(paths["/mcp"]).toBeUndefined();
    expect(paths["/api/mcp"]).toBeUndefined();
  });

  it("documents the request/response schemas that mirror src/schemas/api.ts", () => {
    const schemas = loadSpec().components?.schemas ?? {};
    for (const name of REQUIRED_SCHEMAS) {
      expect(schemas[name], `missing schema ${name}`).toBeDefined();
    }
  });

  it("documents X-CSRF-Token on cookie-mutating REST operations", () => {
    const doc = loadSpec();
    expect(doc.components?.parameters?.CsrfToken).toBeDefined();
    const whoami = doc.components?.schemas?.WhoamiResponse as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(whoami?.properties?.csrf_token).toBeDefined();

    const csrfRef = "#/components/parameters/CsrfToken";
    for (const { path, method } of COOKIE_CSRF_OPERATIONS) {
      const op = doc.paths?.[path]?.[method] as { parameters?: Array<{ $ref?: string }> } | undefined;
      expect(op, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
      const refs = (op?.parameters ?? []).map((p) => p.$ref);
      expect(refs, `${method.toUpperCase()} ${path} missing CsrfToken`).toContain(csrfRef);
    }
  });

  it("accepts a full processing attempt returned by diagnostics", () => {
    const doc = loadSpec();
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    ajv.addSchema(doc, "reading-lite-openapi");
    const validate = ajv.getSchema(
      "reading-lite-openapi#/components/schemas/ProcessingAttempt",
    );
    const attempt = {
      id: "at_01",
      trigger: "submit",
      status: "succeeded",
      stage: "write_indexes",
      started_at: "2026-08-28T18:00:00.000Z",
      finished_at: "2026-08-28T18:00:01.000Z",
      reading_id: "rd_01",
      url: "https://example.com/article",
      url_hash: "a".repeat(64),
      key_prefix: "readings/rd_01",
      events: [
        {
          stage: "fetch_source",
          status: "succeeded",
          at: "2026-08-28T18:00:00.500Z",
          duration_ms: 500,
        },
      ],
    };

    expect(validate).toBeDefined();
    expect(validate?.(attempt)).toBe(true);
    expect(validate?.({ ...attempt, unexpected: true })).toBe(false);
  });
});
