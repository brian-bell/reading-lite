import {
  parseAuthRootKeyVersion,
  parseAuthRootSecret,
  type AuthRoot,
} from "./crypto";

export function authRootFromEnv(secret: string, versionRaw: string | undefined): AuthRoot {
  return {
    secret: parseAuthRootSecret(secret),
    version: parseAuthRootKeyVersion(versionRaw),
  };
}

export function readAuthRoots(env: {
  AUTH_ROOT_SECRET: string;
  AUTH_ROOT_KEY_VERSION?: string;
  AUTH_PREVIOUS_ROOT_SECRET?: string;
  AUTH_PREVIOUS_ROOT_KEY_VERSION?: string;
}): { authRoot: AuthRoot; previousAuthRoot?: AuthRoot } {
  const authRoot = authRootFromEnv(env.AUTH_ROOT_SECRET, env.AUTH_ROOT_KEY_VERSION);
  const previousAuthRoot = env.AUTH_PREVIOUS_ROOT_SECRET
    ? authRootFromEnv(env.AUTH_PREVIOUS_ROOT_SECRET, env.AUTH_PREVIOUS_ROOT_KEY_VERSION)
    : undefined;
  return previousAuthRoot ? { authRoot, previousAuthRoot } : { authRoot };
}
