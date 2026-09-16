import { createFileRoute } from "@tanstack/react-router";
import { SavePage } from "../../components/SavePage";

// Saving a URL (#431). Under the signed-in guard: a save is a write, so a
// signed-out reader goes to /login?next=%2Fsave and lands back here.
export const Route = createFileRoute("/_authed/save")({
  head: () => ({ meta: [{ title: "Save reading · Reading Lite" }] }),
  component: SavePage,
});
