import { describe, expect, it } from "vitest";
import { isRedditThreadUrl, redditListingToMarkdown } from "../../../src/modules/extractor/reddit";

const REDDIT_THREAD_JSON = JSON.stringify([
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            title: "Learning idiomatic Go coming from Java",
            selftext: "I have been writing Java for years and want to learn idiomatic Go.",
            author: "poster",
            subreddit_name_prefixed: "r/golang",
            is_self: true,
            url: "https://www.reddit.com/r/golang/comments/d0zpsh/learning_idiomatic_go_coming_from_java/",
            score: 42,
            num_comments: 4,
            permalink: "/r/golang/comments/d0zpsh/learning_idiomatic_go_coming_from_java/",
          },
        },
      ],
    },
  },
  {
    kind: "Listing",
    data: {
      children: [
        { kind: "t1", data: { body: "Read the standard library.", author: "top", score: 20 } },
        { kind: "t1", data: { body: "Avoid translating classes directly.", author: "second", score: 10 } },
        { kind: "t1", data: { body: "[deleted]", author: "[deleted]", score: 100 } },
        { kind: "t1", data: { body: "[removed]", author: "mod", score: 90 } },
        { kind: "more", data: {} },
      ],
    },
  },
]);

describe("Reddit URL detection", () => {
  it("recognizes Reddit thread and comment URLs", () => {
    expect(
      isRedditThreadUrl("https://www.reddit.com/r/coding/comments/wienze/hexagonal_architecture_in_java_simplified/"),
    ).toBe(true);
    expect(
      isRedditThreadUrl("https://www.reddit.com/r/flightsim/comments/1m5c9s8/challenging_airport_you_never_heard_of/"),
    ).toBe(true);
    expect(
      isRedditThreadUrl("https://www.reddit.com/r/golang/comments/d0zpsh/learning_idiomatic_go_coming_from_java/"),
    ).toBe(true);
    expect(isRedditThreadUrl("https://www.reddit.com/r/Xennials/comments/1kelqna/comment/mqk9hr1/")).toBe(true);
    expect(isRedditThreadUrl("https://old.reddit.com/r/golang/comments/d0zpsh/title/")).toBe(true);
    expect(isRedditThreadUrl("https://redd.it/d0zpsh")).toBe(true);
  });

  it("recognizes thread URLs from other Reddit web subdomains", () => {
    expect(isRedditThreadUrl("https://sh.reddit.com/r/golang/comments/d0zpsh/title/")).toBe(true);
    expect(isRedditThreadUrl("https://new.reddit.com/r/golang/comments/d0zpsh/title/")).toBe(true);
    expect(isRedditThreadUrl("https://amp.reddit.com/r/Xennials/comments/1kelqna/comment/mqk9hr1/")).toBe(true);
  });

  it("recognizes /s/ share-redirect links (app share button)", () => {
    // These resolve to a thread but carry no /comments/ segment. They must be
    // detected so the worker fails them (RedditManualImportError) rather than
    // following the redirect and capturing the bot-challenge page.
    expect(isRedditThreadUrl("https://www.reddit.com/r/golang/s/AbC123xyz")).toBe(true);
    expect(isRedditThreadUrl("https://sh.reddit.com/r/golang/s/AbC123xyz")).toBe(true);
    expect(isRedditThreadUrl("https://reddit.com/r/Xennials/s/9zQ1k")).toBe(true);
  });

  it("rejects non-thread Reddit URLs and non-Reddit URLs", () => {
    expect(isRedditThreadUrl("https://reddit.com/r/golang")).toBe(false);
    expect(isRedditThreadUrl("https://reddit.com/user/foo")).toBe(false);
    expect(isRedditThreadUrl("https://redd.it/d0zpsh/extra")).toBe(false);
    expect(isRedditThreadUrl("https://example.com/r/golang/comments/d0zpsh/title/")).toBe(false);
    expect(isRedditThreadUrl("https://notreddit.com/r/golang/comments/d0zpsh/title/")).toBe(false);
    expect(isRedditThreadUrl("https://reddit.com.evil.com/r/golang/comments/d0zpsh/title/")).toBe(false);
    expect(isRedditThreadUrl("not a url")).toBe(false);
  });
});

describe("redditListingToMarkdown", () => {
  it("renders a self-post and top comments as markdown", () => {
    const out = redditListingToMarkdown(REDDIT_THREAD_JSON);

    expect(out?.title).toBe("Learning idiomatic Go coming from Java");
    expect(out?.markdown).toContain("# Learning idiomatic Go coming from Java");
    expect(out?.markdown).toContain("*Posted by u/poster in r/golang*");
    expect(out?.markdown).toContain("I have been writing Java");
    expect(out?.markdown).toContain("## Top comments");
    expect(out?.markdown).toContain("**u/top** (20 pts): Read the standard library.");
  });

  it("sorts comments by score, caps them, and excludes deleted or removed bodies", () => {
    const out = redditListingToMarkdown(REDDIT_THREAD_JSON, { maxComments: 1 });

    expect(out?.markdown).toContain("Read the standard library.");
    expect(out?.markdown).not.toContain("Avoid translating classes directly.");
    expect(out?.markdown).not.toContain("[deleted]");
    expect(out?.markdown).not.toContain("[removed]");
  });

  it("renders link posts when selftext is empty", () => {
    const json = JSON.stringify([
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t3",
              data: {
                title: "External article",
                selftext: "",
                is_self: false,
                url: "https://example.com/article",
              },
            },
          ],
        },
      },
    ]);

    expect(redditListingToMarkdown(json)?.markdown).toContain("Link: https://example.com/article");
  });

  it("returns null for malformed or non-thread payloads", () => {
    expect(redditListingToMarkdown("not json")).toBeNull();
    expect(redditListingToMarkdown("[]")).toBeNull();
    expect(redditListingToMarkdown(JSON.stringify([{ kind: "Listing", data: { children: [] } }]))).toBeNull();
  });
});
