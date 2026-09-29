import { useEffect, useReducer, useRef, useState } from "react";
import type {
  DeploymentDetail,
  DeploymentSummary,
  LogLine,
  LogTail,
  ProgressMessage,
} from "@shipyard/shared";
import { deploymentStatusOf, reduceProgress } from "@shipyard/shared";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

// ---------------------------------------------------------------- progress

interface LiveState {
  detail: DeploymentDetail | null;
  clockSkew: number; // serverNow - Date.now() at snapshot time
}

type LiveAction =
  | { type: "snapshot"; detail: DeploymentDetail }
  | { type: "progress"; msg: ProgressMessage }
  | { type: "deployment"; summary: DeploymentSummary };

function liveReducer(s: LiveState, a: LiveAction): LiveState {
  switch (a.type) {
    case "snapshot":
      return { detail: a.detail, clockSkew: a.detail.serverNow - Date.now() };
    case "progress": {
      const d = s.detail;
      if (!d || a.msg.seq <= d.lastSeq) return s;
      const state = reduceProgress(d.state, a.msg.event);
      const status = deploymentStatusOf(state.tasks.map((t) => t.status));
      return {
        ...s,
        detail: { ...d, state, lastSeq: a.msg.seq, deployment: { ...d.deployment, status } },
      };
    }
    case "deployment": {
      const d = s.detail;
      if (!d) return s;
      return { ...s, detail: { ...d, deployment: a.summary } };
    }
  }
}

// Subscribes to /api/deployments/:id/events. Every (re)connect starts with a
// full snapshot, so the reducer state is simply replaced; progress events are
// applied on top with the same reducer the server uses.
export function useDeploymentStream(id: number, onEnd?: () => void) {
  const [live, dispatch] = useReducer(liveReducer, { detail: null, clockSkew: 0 });
  const [conn, setConn] = useState<ConnState>("connecting");
  const [ended, setEnded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    setConn("connecting");
    setEnded(false);
    setNotFound(false);
    let done = false;
    const es = new EventSource(`/api/deployments/${id}/events`);
    es.addEventListener("open", () => setConn("open"));
    es.addEventListener("snapshot", (e) => dispatch({ type: "snapshot", detail: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("progress", (e) => dispatch({ type: "progress", msg: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("deployment", (e) => dispatch({ type: "deployment", summary: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("end", () => {
      done = true;
      es.close();
      setConn("closed");
      // Progress events only carry the reducer state; the persisted env rows
      // (commit, error summary, timings) are final now — load them once.
      fetch(`/api/deployments/${id}`)
        .then((r) => (r.ok ? (r.json() as Promise<DeploymentDetail>) : null))
        .then((detail) => detail && dispatch({ type: "snapshot", detail }))
        .catch(() => {})
        .finally(() => {
          setEnded(true);
          onEndRef.current?.();
        });
    });
    es.addEventListener("error", () => {
      if (done) return;
      if (es.readyState === EventSource.CLOSED) {
        // The server answered with an error (404 / 403): EventSource gives up.
        setConn("closed");
        fetch(`/api/deployments/${id}`).then((r) => r.status === 404 && setNotFound(true), () => {});
      } else {
        setConn("reconnecting");
      }
    });
    return () => {
      done = true;
      es.close();
    };
  }, [id]);

  return { detail: live.detail, clockSkew: live.clockSkew, conn, ended, notFound };
}

// -------------------------------------------------------------------- logs

const MAX_LINES = 20000;

interface LogState {
  lines: LogLine[];
  skipped: number;
  trimmed: number;
}

type LogAction = { type: "reset" } | { type: "tail"; tail: LogTail } | { type: "lines"; lines: LogLine[] };

function logReducer(s: LogState, a: LogAction): LogState {
  switch (a.type) {
    case "reset":
      return { lines: [], skipped: 0, trimmed: 0 };
    case "tail":
      return { lines: a.tail.lines, skipped: a.tail.skipped, trimmed: 0 };
    case "lines": {
      const lines = s.lines.concat(a.lines);
      const over = lines.length - MAX_LINES;
      return over > 0 ? { ...s, lines: lines.slice(over), trimmed: s.trimmed + over } : { ...s, lines };
    }
  }
}

// Follows one environment's log. Only the env being viewed is followed, so a
// page never holds more than two SSE connections (HTTP/1.1 allows 6 per host).
export function useLogStream(id: number, idx: number | null) {
  const [state, dispatch] = useReducer(logReducer, { lines: [], skipped: 0, trimmed: 0 });
  const [conn, setConn] = useState<ConnState>("connecting");

  useEffect(() => {
    dispatch({ type: "reset" });
    if (idx === null) return;
    setConn("connecting");
    let done = false;
    const es = new EventSource(`/api/deployments/${id}/envs/${idx}/logs?follow=1`);
    es.addEventListener("open", () => setConn("open"));
    // On reconnect the server re-sends the tail, which replaces what we had.
    es.addEventListener("tail", (e) => dispatch({ type: "tail", tail: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("lines", (e) => dispatch({ type: "lines", lines: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("end", () => {
      done = true;
      es.close();
      setConn("closed");
    });
    es.addEventListener("error", () => {
      if (done) return;
      setConn(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    });
    return () => {
      done = true;
      es.close();
    };
  }, [id, idx]);

  return { ...state, conn };
}
