import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whoamiQueryKey, type Identity } from "../src/identity";
import { meaningQuestionOf } from "../src/similar-readings";
import { runMeaningSearch, useMeaningResult } from "../src/similar-readings-query";

const QUESTION = meaningQuestionOf("what about ada");
const READER: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};
const FOUND = {
  items: [{ id: "rd_a", url: "https://a.example/ada", title: "Ada", score: 0.9 }],
};

interface SearchPost {
  path: string;
  body: unknown;
}

function searchAnswer(): Response {
  return new Response(JSON.stringify(FOUND), { status: 200, headers: { "content-type": "application/json" } });
}

function installSearch(posts: SearchPost[]): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname !== "/api/readings/search") {
      return new Response(null, { status: 404 });
    }
    posts.push({ path: new URL(request.url).pathname, body: await request.json() });
    return searchAnswer();
  });
}

describe("meaning search offline", () => {
  let queryClient: QueryClient;

  afterEach(async () => {
    await queryClient.cancelQueries();
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
  });

  function mount(question = QUESTION) {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(whoamiQueryKey, READER);
    const view = renderHook(() => useMeaningResult(question), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    return view;
  }

  it("settles an offline Find as offline, and reconnect does not post the question", async () => {
    const posts: SearchPost[] = [];
    installSearch(posts);
    onlineManager.setOnline(false);
    const { result } = mount();

    let beforeReconnect: "settled" | "paused" = "paused";
    await act(async () => {
      const search = runMeaningSearch(queryClient, READER, QUESTION!).then(() => "settled" as const);
      beforeReconnect = await Promise.race([
        search,
        new Promise<"paused">((resolve) => setTimeout(() => resolve("paused"), 50)),
      ]);
      if (beforeReconnect === "paused") onlineManager.setOnline(true);
      await search;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect({ beforeReconnect, posts, view: result.current }).toEqual({
      beforeReconnect: "settled",
      posts: [],
      view: { state: "offline" },
    });

    await act(async () => {
      onlineManager.setOnline(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect({ posts, view: result.current }).toEqual({
      posts: [],
      view: { state: "offline" },
    });
  });

  it("posts one question while online and shows the banded reading", async () => {
    const posts: SearchPost[] = [];
    installSearch(posts);
    onlineManager.setOnline(true);
    const { result } = mount();

    await act(async () => {
      await runMeaningSearch(queryClient, READER, QUESTION!);
    });

    expect(posts).toEqual([{ path: "/api/readings/search", body: { query: "what about ada" } }]);
    await waitFor(() => {
      expect(result.current).toEqual({
        state: "done",
        outcome: {
          kind: "results",
          items: [{ id: "rd_a", url: "https://a.example/ada", title: "Ada", closeness: "Close" }],
        },
      });
    });
  });
});
