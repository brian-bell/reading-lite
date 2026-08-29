let heldMagicLinkCredential = "";

/** Keep the fragment across StrictMode remounts after replaceState strips the URL. */
export function captureMagicLinkCredential(rawHash: string): string {
  const fromUrl = rawHash.replace(/^#/, "").trim();
  if (fromUrl !== "") heldMagicLinkCredential = fromUrl;
  return heldMagicLinkCredential;
}

export function clearMagicLinkCredential(): void {
  heldMagicLinkCredential = "";
}
