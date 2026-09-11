import { loginHref } from "../auth/return-path";
import { PageHeading } from "./PageHeading";

// Expired session (acceptance matrix, Common states): shown in place of the
// page at the URL where a request returned 401. The URL stays; sign-in returns
// here. A full page load, so the next page starts from a fresh cache.
export function SessionEnded({ href }: { href: string }) {
  return (
    <div className="page auth-page">
      <PageHeading>Your session ended.</PageHeading>
      <p className="auth-lede">Sign in again to pick up where you left off.</p>
      <div className="form-actions">
        <a className="button button-primary" href={loginHref(href)}>
          Sign in
        </a>
      </div>
    </div>
  );
}
