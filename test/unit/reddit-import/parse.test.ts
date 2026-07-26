import { describe, expect, it } from "vitest";
import { buildRedditImport } from "../../../scripts/reddit-import-lib/parse";
import threadFixture from "../../fixtures/reddit/thread.json";

const THREAD_JSON = JSON.stringify(threadFixture);

describe("buildRedditImport", () => {
  it("renders a thread listing into an import request keyed by the original url", () => {
    const req = buildRedditImport(
      "https://www.reddit.com/r/programming/comments/1ua2lxq/old_software/",
      THREAD_JSON,
    );
    expect(req).not.toBeNull();
    expect(req!.source_url).toBe(
      "https://www.reddit.com/r/programming/comments/1ua2lxq/old_software/",
    );
    expect(req!.title).toBe("Old Software Was Fast Because It Had No Choice");
    expect(req!.markdown).toContain("# Old Software Was Fast Because It Had No Choice");
    expect(req!.markdown).toContain("## Top comments");
    expect(req!.markdown).toContain("Old software wasn't actually fast.");
  });

  it("returns null when the json isn't a Reddit thread (e.g. a saved challenge page)", () => {
    expect(buildRedditImport("https://www.reddit.com/r/x/comments/1", "<html>challenge</html>")).toBeNull();
    expect(buildRedditImport("https://www.reddit.com/r/x/comments/1", "{}")).toBeNull();
  });
});
