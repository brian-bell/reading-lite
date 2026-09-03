import { describe, expect, it, vi } from "vitest";
import type { ListIndexItem } from "../../../src/schemas/api";
import {
  digestSubject,
  displayTitle,
  renderDigestHtml,
  renderDigestText,
  selectDigestReadings,
  sendDigestEmail,
  UNKNOWN_READING_LABEL,
} from "../../../src/modules/digest-email";
import { joinUrl } from "../../../src/modules/email";

const WEB_BASE = "https://reading.test.example";
const WINDOW = {
  startMs: Date.parse("2026-09-01T09:00:00.000Z"),
  endMs: Date.parse("2026-09-02T09:00:00.000Z"),
};

function item(partial: Partial<ListIndexItem> & Pick<ListIndexItem, "id">): ListIndexItem {
  return {
    key_prefix: `readings/${partial.id}`,
    url: `https://example.com/${partial.id}`,
    status: "ready",
    title: `Title ${partial.id}`,
    tldr: `Tldr ${partial.id}`,
    created_at: "2026-09-02T08:00:00.000Z",
    updated_at: "2026-09-02T08:00:00.000Z",
    ...partial,
  };
}

describe("selectDigestReadings", () => {
  it("keeps ready title+tldr rows in the window and drops the rest", () => {
    const inWindow = item({ id: "rd_IN" });
    const old = item({
      id: "rd_OLD",
      title: "Corpus dump candidate",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const atStart = item({
      id: "rd_START",
      created_at: "2026-09-01T09:00:00.000Z",
      updated_at: "2026-09-01T09:00:00.000Z",
    });
    const failed = item({ id: "rd_FAIL", status: "failed" });
    const pending = item({ id: "rd_PEND", status: "pending" });
    const noTldr = item({ id: "rd_NOTLDR", tldr: undefined });
    const createdOnly = item({
      id: "rd_CREATED",
      updated_at: undefined,
      created_at: "2026-09-02T07:00:00.000Z",
    });
    const selected = selectDigestReadings(
      [old, failed, pending, noTldr, atStart, createdOnly, inWindow],
      WINDOW,
    );
    expect(selected.map((row) => row.id)).toEqual(["rd_IN", "rd_CREATED"]);
  });

  it("prefers updated_at over created_at when both are present", () => {
    const selected = selectDigestReadings(
      [
        item({
          id: "rd_REPROCESS",
          created_at: "2026-09-02T08:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
      WINDOW,
    );
    expect(selected).toEqual([]);
  });
});

describe("digest renderer", () => {
  const items = [
    item({ id: "rd_ONE", title: "Alpha <x>", tldr: "First & only" }),
    item({ id: "rd_TWO", title: "Beta", tldr: "Second" }),
  ];
  const titleById = new Map([
    ["rd_ONE", "Alpha <x>"],
    ["rd_TWO", "Beta"],
  ]);
  const input = { cadence: "daily" as const, items, webBaseUrl: WEB_BASE, titleById };

  it("renders html/text with tenant titles, ids, and WEB_BASE_URL", () => {
    const html = renderDigestHtml(input);
    const text = renderDigestText(input);
    expect(html).toContain(joinUrl(WEB_BASE, "/readings/rd_ONE"));
    expect(html).toContain(joinUrl(WEB_BASE, "/readings/rd_TWO"));
    expect(html).toContain("Alpha &lt;x&gt;");
    expect(html).toContain("First &amp; only");
    expect(html).not.toContain("Alpha <x>");
    expect(text).toContain(`${WEB_BASE}/readings/rd_ONE`);
    expect(text).toContain("Beta");
    expect(digestSubject("daily", 2)).toBe("Daily digest · 2 readings");
  });

  it("falls back to (unknown reading) when the tenant map has no title", () => {
    expect(displayTitle("rd_MISSING", titleById)).toBe(UNKNOWN_READING_LABEL);
    const html = renderDigestHtml({
      ...input,
      items: [item({ id: "rd_MISSING", title: "Should not win" })],
      titleById,
    });
    expect(html).toContain(UNKNOWN_READING_LABEL);
    expect(html).toContain(`${WEB_BASE}/readings/rd_MISSING`);
    expect(html).not.toContain("Should not win");
  });
});

describe("sendDigestEmail", () => {
  it("POSTs to Resend with the recipient and never EMAIL_TO", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: "re_digest" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const out = await sendDigestEmail(
      {
        cadence: "weekly",
        items: [item({ id: "rd_ONE" })],
        webBaseUrl: WEB_BASE,
        titleById: new Map([["rd_ONE", "Alpha"]]),
      },
      {
        fetch: fetchFn,
        apiKey: "re_secret",
        from: "reading-lite@from.example",
        to: "reader-display@example.com",
        idempotencyKey: "usr_test:weekly:2026-W36",
      },
    );
    expect(out.id).toBe("re_digest");
    const init = fetchFn.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("Idempotency-Key")).toBe("usr_test:weekly:2026-W36");
    const body = JSON.parse(String(init.body)) as {
      to: string;
      subject: string;
      html: string;
    };
    expect(body.to).toBe("reader-display@example.com");
    expect(JSON.stringify(body)).not.toContain("EMAIL_TO");
    expect(body.subject).toBe("Weekly digest · 1 reading");
    expect(body.html).toContain("Alpha");
  });
});
