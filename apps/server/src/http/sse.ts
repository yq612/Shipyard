import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";

const HEARTBEAT_MS = 5000;

// SSE response with a heartbeat comment (Bun closes connections idle for 10s)
// and `X-Accel-Buffering: no` so nginx doesn't buffer events. The body runs
// until it resolves or the client goes away; `closed` resolves on either.
export function sse(
  c: Context,
  body: (stream: SSEStreamingApi, closed: Promise<void>) => Promise<void>,
): Response {
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    stream.onAbort(() => resolveClosed());
    c.req.raw.signal.addEventListener("abort", () => resolveClosed(), { once: true });
    const timer = setInterval(() => {
      void stream.write(": ping\n\n").catch(() => resolveClosed());
    }, HEARTBEAT_MS);
    try {
      await body(stream, closed);
    } finally {
      clearInterval(timer);
      resolveClosed();
    }
  });
}

// Serialises async writes so events keep their order even when pushed from sync callbacks.
export function writeQueue(stream: SSEStreamingApi) {
  let chain = Promise.resolve();
  return (event: string, data: unknown, id?: string | number) => {
    chain = chain.then(() =>
      stream.writeSSE({ event, data: JSON.stringify(data), ...(id !== undefined ? { id: String(id) } : {}) }).catch(() => {}),
    );
    return chain;
  };
}
