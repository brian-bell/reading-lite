import { useQuery } from "@tanstack/react-query";
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell, type AccountState } from "../components/AppShell";
import { useThemePreference } from "../components/use-theme-preference";
import { whoamiQueryOptions } from "../identity-query";
import type { RouterContext } from "../router";
import stylesUrl from "../styles/app.css?url";
import { getThemePreference } from "../theme-preference";
import { themeAttribute } from "../theme";

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: () => ({ theme: getThemePreference() }),
  // Identity for the account menu, read during the server render and
  // dehydrated with this request's QueryClient. prefetchQuery never throws: an
  // unavailable backend renders the shell without identity instead of failing.
  loader: ({ context }) => context.queryClient.prefetchQuery(whoamiQueryOptions()),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Reading Lite" },
    ],
    links: [{ rel: "stylesheet", href: stylesUrl }],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  const { theme: initialTheme } = Route.useRouteContext();
  const [theme, setTheme] = useThemePreference(initialTheme);
  const { data: identity } = useQuery(whoamiQueryOptions());
  const account: AccountState =
    identity === undefined
      ? { status: "unknown" }
      : identity === null
        ? { status: "signed-out" }
        : { status: "signed-in", email: identity.email };
  return (
    <html lang="en" data-theme={themeAttribute(theme)}>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShell theme={theme} onThemeChange={setTheme} account={account}>
          {children}
        </AppShell>
        <Scripts />
      </body>
    </html>
  );
}
