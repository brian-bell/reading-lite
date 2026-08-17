import { parseTokenId, type TokenId } from "./ids";

export type PresentedToken =
  | { format: "legacy"; secret: string }
  | { format: "standard"; selector: TokenId; secret: string };

export function parsePresentedToken(raw: string): PresentedToken | null {
  const secret = raw.trim();
  if (!secret) return null;

  const dot = secret.indexOf(".");
  if (dot > 0) {
    const selector = parseTokenId(secret.slice(0, dot));
    const material = secret.slice(dot + 1);
    if (selector && material) {
      return { format: "standard", selector, secret: material };
    }
  }

  return { format: "legacy", secret };
}
