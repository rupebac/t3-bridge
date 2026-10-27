import { z } from "zod";
import type { Dpop } from "./dpop.js";
import { BridgeError } from "./errors.js";
import { Http } from "./http.js";
import {
  parseBounded,
  parseHistory,
  parseShell,
  type BoundedView,
  type ShellView,
} from "./protocol-v2.js";

export interface RelayEnv {
  origin: string;
  accessToken: string;
  signer: Dpop;
  http?: Http;
}

async function getJson(env: RelayEnv, path: string): Promise<unknown> {
  const http = env.http ?? new Http();
  const url = new URL(path, env.origin.endsWith("/") ? env.origin : `${env.origin}/`);
  const { data } = await http.request(url.href, z.unknown(), {
    headers: {
      authorization: `DPoP ${env.accessToken}`,
      dpop: env.signer.proof("GET", url.href, env.accessToken),
      "x-t3-orchestration-protocol": "2",
    },
  });
  return data;
}

export interface RelayDocument<T> {
  raw: unknown;
  view: T;
}

export async function fetchShellDocument(env: RelayEnv): Promise<RelayDocument<ShellView>> {
  const raw = await getJson(env, "/api/orchestration/shell");
  const parsed = parseShell(raw);
  if (!parsed.ok) throw new BridgeError("incompatible_response", "The shell response was not an object.");
  return { raw, view: parsed.value };
}

export async function fetchShell(env: RelayEnv): Promise<ShellView> {
  return (await fetchShellDocument(env)).view;
}

export async function fetchBoundedDocument(env: RelayEnv, threadId: string): Promise<RelayDocument<BoundedView>> {
  const raw = await getJson(env, `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`);
  const parsed = parseBounded(raw);
  if (!parsed.ok) throw new BridgeError("incompatible_response", "The thread snapshot was not an object.");
  return { raw, view: parsed.value };
}

export async function fetchBounded(env: RelayEnv, threadId: string): Promise<BoundedView> {
  return (await fetchBoundedDocument(env, threadId)).view;
}

export type HistoryView = Pick<BoundedView, "snapshotSequence" | "messages" | "historyCursor" | "hasMoreHistory" | "warnings">;

export async function fetchHistoryDocument(env: RelayEnv, threadId: string, cursor?: string): Promise<RelayDocument<HistoryView>> {
  const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}/history`;
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
  const raw = await getJson(env, `${path}${query}`);
  const parsed = parseHistory(raw);
  if (!parsed.ok) throw new BridgeError("incompatible_response", "The history response was not an object.");
  return { raw, view: parsed.value };
}

export async function fetchHistory(env: RelayEnv, threadId: string, cursor?: string): Promise<HistoryView> {
  return (await fetchHistoryDocument(env, threadId, cursor)).view;
}
