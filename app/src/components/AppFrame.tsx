import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { signOut, useSessionEndedAt } from "../auth/session";
import { whoamiQueryOptions } from "../identity-query";
import type { ThemePreference } from "../theme";
import { AppShell, type AccountState } from "./AppShell";
import { focusPageHeading, useFocusHeadingOnNavigation } from "./PageHeading";
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
  const href = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).href });
  const { data: identity } = useQuery(whoamiQueryOptions());
  const sessionEndedAt = useSessionEndedAt();
  useFocusHeadingOnNavigation();

  const account: AccountState =
    identity === undefined
      ? { status: "unknown" }
      : identity === null
        ? { status: "signed-out" }
        : { status: "signed-in", email: identity.email };

  // Sign out in place: guarded pages then redirect to sign-in with a return
  // path, and the library shows the sign-in form.
  async function onSignOut() {
    await signOut(queryClient);
    await router.invalidate();
    focusPageHeading();
  }

  return (
    <AppShell theme={theme} onThemeChange={onThemeChange} account={account} onSignOut={onSignOut}>
      {sessionEndedAt === href ? <SessionEnded href={href} /> : children}
    </AppShell>
  );
}
