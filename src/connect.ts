import { z } from "zod";
import { secureOrigin, type Config } from "./config.js";
import { Dpop, generateDpopKey } from "./dpop.js";
import { BridgeError } from "./errors.js";
import { form, Http, jsonBody } from "./http.js";
import type { ClerkAuth } from "./auth.js";
import type { Store } from "./store.js";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("DPoP"),
  expires_in: z.number().positive(),
  scope: z.string(),
});

const environmentSchema = z.object({
  environmentId: z.string().min(1).max(2000),
  label: z.string().max(500),
  endpoint: z.object({
    httpBaseUrl: z.string().min(1),
    wsBaseUrl: z.string().min(1),
  }),
});

const connectionSchema = z.object({
  environmentId: z.string().min(1).max(2000),
  endpoint: z.object({
    httpBaseUrl: z.string().min(1),
    wsBaseUrl: z.string().min(1),
  }),
  credential: z.string().min(1),
  expiresAt: z.string(),
});

export interface LinkedEnvironment {
  environmentId: string;
  label: string;
  httpBaseUrl: string;
  wsBaseUrl: string;
}

export interface EnvironmentPage {
  environments: LinkedEnvironment[];
  warnings: string[];
}

export interface EnvironmentCredential {
  environmentId: string;
  accessToken: string;
  origin: string;
  wsUrl: string;
  expiresAt: number;
  ttlMs?: number;
  signer: Dpop;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const relayScopes = ["environment:connect", "environment:status"];
const orchestrationScopes = ["orchestration:read", "orchestration:operate"];
const tokenExchange = "urn:ietf:params:oauth:grant-type:token-exchange";
const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";

export class Connect {
  private relay?: CachedToken;
  private sessions = new Map<string, EnvironmentCredential>();
  private inflight = new Map<string, Promise<EnvironmentCredential>>();
  private signerTask?: Promise<Dpop>;

  constructor(private config: Config, private http: Http, private auth: ClerkAuth, private store: Store) {}

  private signer(): Promise<Dpop> {
    this.signerTask ??= this.loadSigner();
    return this.signerTask;
  }

  private async loadSigner(): Promise<Dpop> {
    const existing = await this.store.readPrivateJwk();
    if (existing) return new Dpop(existing);
    const created = generateDpopKey();
    await this.store.savePrivateJwk(created);
    return new Dpop(created);
  }

  async availability(environmentId: string): Promise<"online" | "offline"> {
    const signer = await this.signer();
    const token = await this.relayToken(signer);
    const url = `${this.config.relayOrigin}/v1/environments/${encodeURIComponent(environmentId)}/status`;
    const { data } = await this.http.request(url, z.object({
      environmentId: z.string(),
      status: z.enum(["online", "offline"]),
    }), {
      method: "POST",
      headers: {
        authorization: `DPoP ${token}`,
        dpop: signer.proof("POST", url, token),
      },
    });
    if (data.environmentId !== environmentId) throw new BridgeError("identity_mismatch", "Relay returned a different environment ID.");
    return data.status;
  }

  async listEnvironments(): Promise<EnvironmentPage> {
    const token = await this.auth.token();
    const { data } = await this.http.request(`${this.config.relayOrigin}/v1/environments`, z.object({
      environments: z.array(z.unknown()),
    }), { headers: { authorization: `Bearer ${token}` } });
    const environments: LinkedEnvironment[] = [];
    const warnings: string[] = [];
    for (const row of data.environments) {
      try {
        const parsed = environmentSchema.safeParse(row);
        if (!parsed.success) {
          warnings.push("Skipped an environment row.");
          continue;
        }
        const normalized = normalizeEndpoint(parsed.data.endpoint.httpBaseUrl, parsed.data.endpoint.wsBaseUrl);
        environments.push({
          environmentId: parsed.data.environmentId,
          label: parsed.data.label,
          httpBaseUrl: normalized.origin,
          wsBaseUrl: normalized.wsUrl,
        });
      } catch {
        warnings.push("Skipped an environment row with an unsupported endpoint.");
      }
    }
    return { environments, warnings };
  }

  private async relayToken(signer: Dpop): Promise<string> {
    if (this.relay && this.relay.expiresAt > Date.now() + 30_000) return this.relay.value;
    const url = `${this.config.relayOrigin}/v1/client/dpop-token`;
    const request = form({
      grant_type: tokenExchange,
      subject_token: await this.auth.token(),
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      requested_token_type: accessTokenType,
      resource: this.config.relayOrigin,
      scope: relayScopes.join(" "),
      client_id: "t3-web",
    });
    const started = Date.now();
    const { data } = await this.http.request(url, tokenSchema, {
      ...request,
      headers: { ...request.headers, dpop: signer.proof("POST", url) },
    });
    if (!relayScopes.every(scope => data.scope.split(" ").includes(scope))) {
      throw new BridgeError("insufficient_scope", "The relay did not grant environment connection and status access.");
    }
    this.relay = { value: data.access_token, expiresAt: started + data.expires_in * 1000 };
    return data.access_token;
  }

  dropCredential(environmentId?: string): void {
    this.relay = undefined;
    if (environmentId) this.sessions.delete(environmentId);
    else this.sessions.clear();
  }

  cachedExpiry(environmentId: string): string | null {
    const cached = this.sessions.get(environmentId);
    return cached ? new Date(cached.expiresAt).toISOString() : null;
  }

  acquireEnvironmentCredential(environmentId: string): Promise<EnvironmentCredential> {
    const pending = this.inflight.get(environmentId);
    if (pending) return pending;
    const task = this.loadEnvironmentCredential(environmentId).finally(() => {
      this.inflight.delete(environmentId);
    });
    this.inflight.set(environmentId, task);
    return task;
  }

  private async loadEnvironmentCredential(environmentId: string): Promise<EnvironmentCredential> {
    const cached = this.sessions.get(environmentId);
    const ttl = cached?.ttlMs ?? 0;
    const refreshWindow = Math.max(30_000, ttl * 0.2);
    if (cached && cached.expiresAt > Date.now() + refreshWindow) return cached;
    const signer = await this.signer();
    const known = (await this.listEnvironments()).environments.find(environment => environment.environmentId === environmentId);
    if (!known) throw new BridgeError("environment_not_found", "This environment is not linked to the signed-in account.");
    const token = await this.relayToken(signer);
    const url = `${this.config.relayOrigin}/v1/environments/${encodeURIComponent(environmentId)}/connect`;
    const request = jsonBody({ clientProofKeyThumbprint: signer.thumbprint });
    let connection: z.infer<typeof connectionSchema>;
    try {
      connection = (await this.http.request(url, connectionSchema, {
        ...request,
        headers: { ...request.headers, authorization: `DPoP ${token}`, dpop: signer.proof("POST", url, token) },
      })).data;
    } catch (error) {
      if (error instanceof BridgeError && error.code === "auth_required") this.relay = undefined;
      throw error;
    }
    const endpoint = normalizeEndpoint(connection.endpoint.httpBaseUrl, connection.endpoint.wsBaseUrl);
    if (connection.environmentId !== environmentId || endpoint.origin !== known.httpBaseUrl || endpoint.wsUrl !== known.wsBaseUrl) {
      throw new BridgeError("identity_mismatch", "The relay connection does not match the selected environment.");
    }
    const exchangeUrl = `${endpoint.origin}/oauth/token`;
    const exchange = form({
      grant_type: tokenExchange,
      subject_token: connection.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: accessTokenType,
      scope: orchestrationScopes.join(" "),
      client_label: "t3-bridge",
      client_device_type: "desktop",
    });
    const started = Date.now();
    const { data } = await this.http.request(exchangeUrl, tokenSchema, {
      ...exchange,
      headers: { ...exchange.headers, dpop: signer.proof("POST", exchangeUrl) },
    });
    if (!orchestrationScopes.every(scope => data.scope.split(" ").includes(scope))) {
      throw new BridgeError("insufficient_scope", "The environment did not grant orchestration access.");
    }
    const session: EnvironmentCredential = {
      environmentId,
      accessToken: data.access_token,
      origin: endpoint.origin,
      wsUrl: endpoint.wsUrl,
      expiresAt: started + data.expires_in * 1000,
      ttlMs: data.expires_in * 1000,
      signer,
    };
    this.sessions.set(environmentId, session);
    return session;
  }
}

function normalizeEndpoint(httpBaseUrl: string, wsBaseUrl: string): { origin: string; wsUrl: string } {
  const origin = secureOrigin(httpBaseUrl);
  const ws = new URL(wsBaseUrl);
  const wsOrigin = secureOrigin(ws.origin.replace(/^ws:/, "http:").replace(/^wss:/, "https:"));
  if (wsOrigin !== origin || (ws.protocol !== "ws:" && ws.protocol !== "wss:") || ws.username || ws.password || ws.search || ws.hash || ws.pathname !== "/ws") {
    throw new BridgeError("identity_mismatch", "The environment endpoint is not a T3 relay WebSocket.");
  }
  return { origin, wsUrl: ws.href };
}
