import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authBinding, type Config } from "./config.js";
import { BridgeError } from "./errors.js";
import { form, Http } from "./http.js";
import type { SessionState, Store } from "./store.js";

const factorSchema = z.object({
  strategy: z.string(),
  email_address_id: z.string().optional(),
});

const signInSchema = z.object({
  id: z.string(),
  status: z.string(),
  created_session_id: z.string().nullable().optional(),
  supported_first_factors: z.array(factorSchema).nullable().optional(),
  supported_second_factors: z.array(factorSchema).nullable().optional(),
});

type SignInAttempt = z.infer<typeof signInSchema>;

export const loginStartInput = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
});

export const loginVerifyInput = z.object({
  loginId: z.string().min(1),
  factor: z.enum(["email_code", "totp"]).optional(),
  code: z.string().trim().regex(/^\d{6}$/),
});

export type LoginStatus =
  | { status: "signed_out" | "signed_in" }
  | { status: "code_required"; loginId: string; factor: "email_code" | "totp"; expiresAt: string }
  | { status: "expired" | "restart_required"; loginId: string };

export class ClerkAuth {
  constructor(private config: Config, private http: Http, private store: Store) {}

  private async request<T>(path: string, schema: z.ZodType<T>, fields?: Record<string, string>): Promise<T> {
    await this.checkBinding();
    const url = new URL(path, this.config.clerkOrigin);
    url.searchParams.set("_is_native", "1");
    url.searchParams.set("__clerk_api_version", "2025-11-10");
    const session = await this.store.readSession();
    const init = fields ? form(fields) : {};
    const { data } = await this.http.request(url.toString(), z.unknown(), {
      ...init,
      headers: { ...init.headers, authorization: session?.clientJwt ?? "" },
    }, async headers => {
      const clientJwt = headers.get("authorization");
      if (clientJwt) await this.rememberClient(clientJwt);
    }).catch(error => {
      if (error instanceof BridgeError && error.code === "transport_error") {
        throw new BridgeError("transport_error", "The authentication request failed or timed out. Run login-status before submitting another code.");
      }
      throw error;
    });
    const envelope = z.object({ response: z.unknown() }).safeParse(data);
    const decoded = schema.safeParse(envelope.success ? envelope.data.response : data);
    if (!decoded.success) throw new BridgeError("incompatible_auth_response", "Clerk returned an unsupported authentication response.");
    return decoded.data;
  }

  private async rememberClient(clientJwt: string): Promise<void> {
    const current = await this.store.readSession();
    await this.store.saveSession(sessionFrom(current, { binding: authBinding(this.config), clientJwt }));
  }

  private async checkBinding(): Promise<void> {
    const session = await this.store.readSession();
    if (session && session.binding !== authBinding(this.config)) {
      throw new BridgeError("config_mismatch", "Stored credentials belong to different endpoints. Use a separate T3_BRIDGE_STATE_DIR.");
    }
  }

  private async pendingStatus(): Promise<LoginStatus> {
    const pending = (await this.store.readSession())?.pendingLogin;
    if (!pending) return { status: "signed_out" };
    if (Date.now() >= pending.expiresAt) return { status: "expired", loginId: pending.loginId };
    if (pending.factor === "preparing") return { status: "restart_required", loginId: pending.loginId };
    return {
      status: "code_required",
      loginId: pending.loginId,
      factor: pending.factor,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  private async acceptAttempt(attempt: SignInAttempt): Promise<LoginStatus> {
    const session = await this.store.readSession();
    const pending = session?.pendingLogin;
    if (!pending || attempt.id !== pending.signInId) {
      throw new BridgeError("incompatible_auth_response", "Clerk returned a different sign-in attempt.");
    }
    if (attempt.status === "complete" && attempt.created_session_id) {
      await this.store.saveSession(sessionFrom(session, { sessionId: attempt.created_session_id }));
      return this.finishLogin();
    }
    if (attempt.status === "needs_second_factor") {
      if (!attempt.supported_second_factors?.some(factor => factor.strategy === "totp")) {
        throw new BridgeError("unsupported_second_factor", "This account requires a second factor other than an authenticator code.");
      }
      await this.store.saveSession(sessionFrom(await this.store.readSession(), {
        pendingLogin: { ...pending, factor: "totp" },
      }));
    } else if (attempt.status !== "needs_first_factor") {
      throw new BridgeError("incomplete_sign_in", "Sign-in needs an additional step that this bridge does not support.");
    }
    return this.pendingStatus();
  }

  private async finishLogin(): Promise<LoginStatus> {
    await this.token();
    const session = await this.store.readSession();
    if (!session) throw new BridgeError("login_required", "Sign in before requesting an account token.");
    const { pendingLogin: _pending, ...rest } = session;
    await this.store.saveSession(rest);
    return { status: "signed_in" };
  }

  async loginStatus(): Promise<LoginStatus> {
    await this.checkBinding();
    const session = await this.store.readSession();
    if (session?.sessionId) return this.finishLogin();
    const pending = session?.pendingLogin;
    if (!pending) return { status: "signed_out" };
    try {
      return await this.acceptAttempt(await this.request(`/v1/client/sign_ins/${encodeURIComponent(pending.signInId)}`, signInSchema));
    } catch (error) {
      if (error instanceof BridgeError && error.code === "http_error" && error.details.status === 404) {
        return { status: "expired", loginId: pending.loginId };
      }
      throw error;
    }
  }

  async loginStart(email: string): Promise<LoginStatus> {
    const parsed = loginStartInput.parse({ email });
    await this.checkBinding();
    const existing = await this.store.readSession();
    if (existing?.sessionId) throw new BridgeError("already_signed_in", "Already signed in. Run logout before signing in to another account.");
    if (existing?.pendingLogin) throw new BridgeError("login_in_progress", "Run login-status to resume, or logout to discard the pending login.");
    const attempt = await this.request("/v1/client/sign_ins", signInSchema, { identifier: parsed.email });
    const emailFactor = attempt.supported_first_factors?.find(factor => factor.strategy === "email_code" && factor.email_address_id);
    if (!emailFactor?.email_address_id) {
      throw new BridgeError("unsupported_sign_in", "This account does not offer email-code sign-in.");
    }
    const created = await this.store.readSession();
    if (!created?.clientJwt) throw new BridgeError("incompatible_auth_response", "Clerk did not issue a client credential.");
    await this.store.saveSession(sessionFrom(created, {
      pendingLogin: { loginId: randomUUID(), signInId: attempt.id, expiresAt: Date.now() + 10 * 60_000, factor: "preparing" },
    }));
    await this.request(`/v1/client/sign_ins/${encodeURIComponent(attempt.id)}/prepare_first_factor`, signInSchema, {
      strategy: "email_code",
      email_address_id: emailFactor.email_address_id,
    });
    const prepared = await this.store.readSession();
    if (!prepared?.pendingLogin) throw new BridgeError("incompatible_auth_response", "The pending login disappeared before the email code was prepared.");
    await this.store.saveSession(sessionFrom(prepared, { pendingLogin: { ...prepared.pendingLogin, factor: "email_code" } }));
    return this.pendingStatus();
  }

  async loginVerify(input: { loginId: string; code: string; factor?: "email_code" | "totp" }): Promise<LoginStatus> {
    const parsed = loginVerifyInput.parse(input);
    await this.checkBinding();
    const session = await this.store.readSession();
    if (session?.sessionId) return this.finishLogin();
    if (!session?.pendingLogin) throw new BridgeError("login_required", "Run login-start first.");
    if (session.pendingLogin.loginId !== parsed.loginId) {
      throw new BridgeError("login_mismatch", "This code belongs to a different login attempt. Run login-status.");
    }
    const status = await this.loginStatus();
    if (status.status !== "code_required") return status;
    if (parsed.factor && parsed.factor !== status.factor) return status;
    const pending = (await this.store.readSession())?.pendingLogin;
    if (!pending) return status;
    const action = (parsed.factor ?? status.factor) === "email_code" ? "attempt_first_factor" : "attempt_second_factor";
    return this.acceptAttempt(await this.request(`/v1/client/sign_ins/${encodeURIComponent(pending.signInId)}/${action}`, signInSchema, {
      strategy: parsed.factor ?? status.factor,
      code: parsed.code,
    }));
  }

  async token(): Promise<string> {
    const session = await this.store.readSession();
    if (!session?.sessionId) throw new BridgeError("login_required", "Sign in with t3-bridge login.");
    const { jwt } = await this.request(
      `/v1/client/sessions/${encodeURIComponent(session.sessionId)}/tokens/${encodeURIComponent(this.config.jwtTemplate)}`,
      z.object({ jwt: z.string().min(1) }),
      {},
    );
    let subject: unknown;
    try {
      subject = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()).sub;
    } catch {
      subject = undefined;
    }
    if (typeof subject !== "string" || !subject) throw new BridgeError("invalid_account_token", "The account token has no subject.");
    const current = await this.store.readSession();
    if (current?.accountId && current.accountId !== subject) {
      throw new BridgeError("account_changed", "Account identity changed unexpectedly. Sign in again.");
    }
    await this.store.saveSession(sessionFrom(current, { accountId: subject }));
    return jwt;
  }

  async logout(): Promise<void> {
    const session = await this.store.readSession();
    if (session?.sessionId) {
      try {
        await this.request(`/v1/client/sessions/${encodeURIComponent(session.sessionId)}/end`, z.unknown(), {});
      } catch (error) {
        if (!(error instanceof BridgeError) || error.code !== "auth_required") throw error;
      }
    }
    await this.store.clearAuth();
  }
}

function sessionFrom(current: SessionState | null, patch: Partial<SessionState> & { binding?: string; clientJwt?: string }): SessionState {
  const binding = patch.binding ?? current?.binding;
  const clientJwt = patch.clientJwt ?? current?.clientJwt;
  if (!binding || !clientJwt) throw new BridgeError("login_required", "Sign in with t3-bridge login.");
  const next: SessionState = { binding, clientJwt };
  const sessionId = patch.sessionId ?? current?.sessionId;
  const accountId = patch.accountId ?? current?.accountId;
  const pendingLogin = patch.pendingLogin === undefined ? current?.pendingLogin : patch.pendingLogin;
  if (sessionId) next.sessionId = sessionId;
  if (accountId) next.accountId = accountId;
  if (pendingLogin) next.pendingLogin = pendingLogin;
  return next;
}
