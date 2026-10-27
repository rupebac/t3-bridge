import { createServer, type IncomingMessage } from "node:http";

export interface FakeV2 {
  origin: string;
  threadId: string;
  projectId: string;
  close: () => Promise<void>;
  seenProtocol: string[];
}

async function readBody(req: IncomingMessage): Promise<void> {
  for await (const _chunk of req) { /* drain */ }
}

export async function startFakeV2(): Promise<FakeV2> {
  const threadId = "t".repeat(500);
  const projectId = "p".repeat(300);
  const seenProtocol: string[] = [];
  const server = createServer(async (req, res) => {
    await readBody(req);
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = new URL(req.url ?? "/", origin);
    seenProtocol.push(String(req.headers["x-t3-orchestration-protocol"] ?? ""));
    const respond = (data: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== "DPoP env-token" || !req.headers.dpop) {
      respond({ code: "auth_required" }, 401);
      return;
    }
    if (url.pathname === "/api/orchestration/shell") {
      respond({
        schemaVersion: 2,
        snapshotSequence: 7,
        archivedThreads: [],
        olderSettled: { before: "2026-01-01T00:00:00.000Z", count: 3 },
        projects: [
          {
            id: projectId,
            title: "rperez",
            workspaceRoot: "/home/box/rperez",
            defaultModelSelection: { instanceId: "grok", model: "grok-4", options: [{ id: "effort", value: "high" }] },
            defaultThreadEnvMode: "local",
            futureProject: true,
          },
          { id: "missing-title" },
        ],
        threads: [
          {
            id: threadId,
            projectId,
            title: "Greeting",
            status: "running",
            runtimeMode: "approval-required",
            interactionMode: "default",
            updatedAt: "2026-10-25T11:14:07.100Z",
            activeRunId: "run-1",
            latestRunId: "run-1",
            weirdFutureField: { nested: true },
          },
          { id: "x".repeat(2001), projectId, title: "too-long" },
        ],
      });
      return;
    }
    if (url.pathname === `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`) {
      respond({
        snapshotSequence: 8,
        historyCursor: "older-1",
        hasMoreHistory: true,
        payloadBudgetExceeded: false,
        projection: {
          thread: { id: threadId, projectId, title: "Greeting", status: "completed", future: true },
          runs: [
            { id: "run-1", ordinal: 1, status: "completed", userMessageId: "m-user", providerState: { secret: "hide" } },
            { ordinal: 2 },
          ],
          runtimeRequests: [{ id: "req-1", kind: "command", createdAt: "2026-10-25T11:14:07.100Z", extra: true }],
          visibleTurnItems: [
            { position: 0, visibility: "local", item: { id: "m-user", type: "user_message", text: "hello menet2", messageId: "m-user", attachments: [{ secret: true }] } },
            { position: 1, item: { type: "assistant_message" } },
            { position: 2, item: { id: "m-assistant", type: "assistant_message", text: "done", messageId: "m-assistant" } },
          ],
        },
      });
      return;
    }
    if (url.pathname === `/api/orchestration/threads/${encodeURIComponent(threadId)}/history`) {
      respond({
        snapshotSequence: 8,
        items: [
          { position: 0, item: { id: "m-old", type: "user_message", text: `cursor:${url.searchParams.get("cursor")}`, messageId: "m-old" } },
        ],
        nextCursor: null,
        hasMoreHistory: false,
        extraPage: true,
      });
      return;
    }
    respond({ code: "not_found" }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    threadId,
    projectId,
    seenProtocol,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
