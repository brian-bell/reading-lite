import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppFrame } from "../components/AppFrame";
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
  return (
    <html lang="en" data-theme={themeAttribute(theme)}>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppFrame theme={theme} onThemeChange={setTheme}>
          {children}
        </AppFrame>
        <Scripts />
      </body>
    </html>
  );
}
