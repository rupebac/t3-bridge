import { homedir } from "node:os";
import { resolve } from "node:path";
import { BridgeError } from "./errors.js";

export const DEFAULT_ENVIRONMENT_ID = "43972768-c214-40da-acbe-c9ea9a2e3bd4";
export const MENET2_LABEL = "menet2";

export function secureOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const https = url.protocol === "https:";
    const loopbackHttp = loopback && url.protocol === "http:";
    if ((!https && !loopbackHttp) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "invalid_origin",
      "Use an HTTPS origin, or HTTP on loopback, without credentials, a path, query, or fragment.",
    );
  }
}

export interface Config {
  clerkOrigin: string;
  relayOrigin: string;
  jwtTemplate: string;
  stateDir: string;
  defaultEnvironmentId: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    clerkOrigin: secureOrigin(env.T3_BRIDGE_CLERK_ORIGIN ?? "https://clerk.t3.codes"),
    relayOrigin: secureOrigin(env.T3_BRIDGE_RELAY_ORIGIN ?? "https://relay.t3.codes"),
    jwtTemplate: env.T3_BRIDGE_JWT_TEMPLATE ?? "t3-relay",
    stateDir: resolve(env.T3_BRIDGE_STATE_DIR ?? resolve(homedir(), ".t3-bridge")),
    defaultEnvironmentId: env.T3_BRIDGE_ENVIRONMENT_ID ?? DEFAULT_ENVIRONMENT_ID,
  };
}

export function authBinding(config: Config): string {
  return JSON.stringify([config.clerkOrigin, config.relayOrigin, config.jwtTemplate]);
}
