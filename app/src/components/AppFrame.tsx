import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { dropLegacyBearerToken } from "../auth/legacy-storage";
import { signOut, useSessionEndedAt } from "../auth/session";
import { whoamiQueryOptions } from "../identity-query";
import { isPublicLegalPath } from "../legal";
import type { ThemePreference } from "../theme";
import { AppShell, type AccountState } from "./AppShell";
import { focusPageHeading, useFocusHeadingOnNavigation } from "./PageHeading";
import { useRenderedLocation } from "./rendered-location";
import { SessionEnded } from "./SessionEnded";

// The shell with its session behavior: account state from whoami, sign-out,
// the expired-session page, and heading focus after navigation. The root
// route renders it inside the document.
export function AppFrame({
  theme,
  onThemeChange,
  children,
}: {
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  // The page on screen. While a navigation is pending the old page stays up,
  // so the expired-session page must too, or the old page remounts and
  // refetches.
  const href = useRenderedLocation((location) => location.href);
  const pathname = useRenderedLocation((location) => location.pathname);
  const publicLegal = isPublicLegalPath(pathname);
  // Legal pages skip identity during the server render so the HTML can be
  // cached or prerendered. The browser still reads whoami after hydration.
  const { data: identity } = useQuery({
    ...whoamiQueryOptions(),
    enabled: !publicLegal || typeof document !== "undefined",
  });
  const sessionEndedAt = useSessionEndedAt();
  useFocusHeadingOnNavigation();
  useEffect(dropLegacyBearerToken, []);

  const account: AccountState =
    identity === undefined
      ? publicLegal
        ? { status: "signed-out" }
        : { status: "unknown" }
      : identity === null
        ? { status: "signed-out" }
        : { status: "signed-in", email: identity.email };

  // Sign out in place: guarded pages then redirect to sign-in with a return
  // path, and the library shows the sign-in form.
  async function onSignOut() {
    const result = await signOut(queryClient);
    if (result === "signed-out") {
      await router.invalidate();
      focusPageHeading();
    }
    return result;
  }

  return (
    <AppShell theme={theme} onThemeChange={onThemeChange} account={account} onSignOut={onSignOut}>
      {sessionEndedAt === href ? <SessionEnded href={href} /> : children}
    </AppShell>
  );
}
