import { useEffect } from "react";
import { focusPageHeading, PageHeading } from "./PageHeading";

// Account closing (acceptance matrix, Common states and Account deletion):
// shown in place of the page by the one tab whose DELETE /api/account
// succeeded. The reader is already signed out. Sign-in is refused while the
// account is deleting (src/control-plane/redeem.ts), so this page offers no
// action and promises neither an undo nor an archive export.
export function AccountClosing() {
  // Always a replacement for the account page, whose focused control is gone.
  useEffect(() => focusPageHeading(), []);
  return (
    <div className="page auth-page">
      <PageHeading>Your account is being deleted.</PageHeading>
      <p className="auth-lede">
        You're signed out. Every browser session and API token for this account was revoked.
      </p>
      <p className="auth-lede">
        Your library and everything in it will be permanently deleted after seven days. You can't sign in to
        this account during that time.
      </p>
    </div>
  );
}
