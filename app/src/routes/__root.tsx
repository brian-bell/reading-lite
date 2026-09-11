import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import { useThemePreference } from "../components/use-theme-preference";
import stylesUrl from "../styles/app.css?url";
import { getThemePreference } from "../theme-preference";
import { themeAttribute } from "../theme";

export const Route = createRootRoute({
  beforeLoad: () => ({ theme: getThemePreference() }),
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
        <AppShell theme={theme} onThemeChange={setTheme}>
          {children}
        </AppShell>
        <Scripts />
      </body>
    </html>
  );
}
