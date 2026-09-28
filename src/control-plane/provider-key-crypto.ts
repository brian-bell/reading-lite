import { parseAuthRootKeyVersion, parseProviderKeySecret } from "./crypto";

export interface ProviderKeyRoot {
  secret: Uint8Array;
  version: number;
}

export interface ProviderKeyRoots {
  providerKeyRoot: ProviderKeyRoot;
  previousProviderKeyRoot?: ProviderKeyRoot;
}

const HKDF_SALT = new TextEncoder().encode("reading-lite-provider-key-v1");
const IV_BYTES = 12;

export function parseProviderKeyVersion(
  raw: string | undefined,
  fallback = 1,
): number {
  try {
    return parseAuthRootKeyVersion(raw, fallback);
  } catch {
    throw new Error("provider key version must be a non-negative integer");
  }
}

export function providerKeyRootFromEnv(secret: string, versionRaw: string | undefined): ProviderKeyRoot {
  return {
    secret: parseProviderKeySecret(secret),
    version: parseProviderKeyVersion(versionRaw),
  };
}

export function readProviderKeyRoots(env: {
  PROVIDER_KEY_SECRET?: string;
  PROVIDER_KEY_VERSION?: string;
  PROVIDER_KEY_PREVIOUS_SECRET?: string;
  PROVIDER_KEY_PREVIOUS_VERSION?: string;
}): ProviderKeyRoots {
  if (!env.PROVIDER_KEY_SECRET) {
    throw new Error("PROVIDER_KEY_SECRET must be a 256-bit hex value");
  }
  const providerKeyRoot = providerKeyRootFromEnv(env.PROVIDER_KEY_SECRET, env.PROVIDER_KEY_VERSION);
  const previousProviderKeyRoot = env.PROVIDER_KEY_PREVIOUS_SECRET
    ? providerKeyRootFromEnv(env.PROVIDER_KEY_PREVIOUS_SECRET, env.PROVIDER_KEY_PREVIOUS_VERSION)
    : undefined;
  return previousProviderKeyRoot ? { providerKeyRoot, previousProviderKeyRoot } : { providerKeyRoot };
}

export async function encryptProviderKey(input: {
  root: ProviderKeyRoot;
  tenantId: string;
  credentialVersion: number;
  plaintext: string;
}): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(input.tenantId, input.credentialVersion) },
      await deriveAesKey(input.root),
      new TextEncoder().encode(input.plaintext),
    ),
  );
  return { ciphertext, iv };
}

export async function decryptProviderKey(input: {
  roots: ProviderKeyRoots;
  tenantId: string;
  credentialVersion: number;
  keyVersion: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
}): Promise<string> {
  for (const root of rootsForVersion(input.roots, input.keyVersion)) {
    const plain = await openProviderKey(root, input);
    if (plain !== null) return plain;
  }
  throw new Error("provider key ciphertext failed to decrypt");
}

async function openProviderKey(
  root: ProviderKeyRoot,
  input: {
    tenantId: string;
    credentialVersion: number;
    ciphertext: Uint8Array;
    iv: Uint8Array;
  },
): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes(input.iv),
        additionalData: aad(input.tenantId, input.credentialVersion),
      },
      await deriveAesKey(root),
      bytes(input.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function rootsForVersion(roots: ProviderKeyRoots, keyVersion: number): ProviderKeyRoot[] {
  const matches: ProviderKeyRoot[] = [];
  if (roots.providerKeyRoot.version === keyVersion) matches.push(roots.providerKeyRoot);
  if (roots.previousProviderKeyRoot?.version === keyVersion) matches.push(roots.previousProviderKeyRoot);
  return matches;
}

async function deriveAesKey(root: ProviderKeyRoot): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", bytes(root.secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: new TextEncoder().encode(`reading-lite/v${root.version}/provider_key`),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aad(tenantId: string, credentialVersion: number): Uint8Array {
  const tenant = new TextEncoder().encode(tenantId);
  const version = new TextEncoder().encode(String(credentialVersion));
  const out = new Uint8Array(8 + tenant.byteLength + version.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, tenant.byteLength);
  out.set(tenant, 4);
  view.setUint32(4 + tenant.byteLength, version.byteLength);
  out.set(version, 8 + tenant.byteLength);
  return out;
}

function bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}
