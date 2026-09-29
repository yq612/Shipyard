import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { AnsiUp } from "ansi_up";
import type { LogLine, Stage } from "@shipyard/shared";
import { STAGES, STAGE_NAMES } from "@shipyard/shared";
import { api } from "../api.ts";
import { useLogStream } from "../lib/sse.ts";
import { formatTime } from "../lib/time.ts";

const ansi = new AnsiUp();
ansi.use_classes = true; // colours come from CSS, so they follow the theme
ansi.escape_html = true;

function lineClass(line: LogLine, highlightErr: boolean): string {
  let cls = "log__line";
  if (line.stream === "system") {
    if (line.text.startsWith("$ ")) cls += " log__line--cmd";
    else if (line.text.startsWith("✔")) cls += " log__line--ok";
    else if (line.text.startsWith("✗") || line.text.startsWith("! ")) cls += " log__line--fail";
    else cls += " log__line--system";
  } else if (line.stream === "stderr") {
    cls += " log__line--stderr";
    if (highlightErr) cls += " is-hl";
  }
  return cls;
}

const Line = memo(function Line({ line, highlightErr }: { line: LogLine; highlightErr: boolean }) {
  const isCmd = line.stream === "system" && line.text.startsWith("$ ");
  const html = useMemo(() => ansi.ansi_to_html(isCmd ? line.text.slice(2) : line.text), [line.text, isCmd]);
  return (
    <div className={lineClass(line, highlightErr)}>
      <span className="log__ts">{formatTime(line.ts)}</span>
      <span className="log__text">
        {isCmd && <span className="log__prompt">$ </span>}
        <span dangerouslySetInnerHTML={{ __html: html }} />
      </span>
    </div>
  );
});

type Filter = "all" | Stage;

export function LogViewer({
  deploymentId,
  envIdx,
  envName,
  failedStage,
}: {
  deploymentId: number;
  envIdx: number;
  envName: string;
  failedStage: Stage | null;
}) {
  const { lines, skipped, trimmed, conn } = useLogStream(deploymentId, envIdx);
  const [filter, setFilter] = useState<Filter>("all");
  const [follow, setFollow] = useState(true);
  const ref = useRef<VirtuosoHandle>(null);

  // A failed env opens on the stage that failed.
  useEffect(() => {
    setFilter(failedStage ?? "all");
    setFollow(true);
  }, [deploymentId, envIdx, failedStage]);

  const visible = useMemo(
    () => (filter === "all" ? lines : lines.filter((l) => l.stage === filter)),
    [lines, filter],
  );

  const live = conn === "open" || conn === "connecting" || conn === "reconnecting";
  const statusText =
    conn === "reconnecting" ? <span className="warn">日志连接中断，正在重连…</span>
      : conn === "closed" ? <span>已结束 · {lines.length + skipped} 行</span>
        : <span className="ok">实时</span>;

  return (
    <section className="term log" aria-label={`${envName} 的构建日志`}>
      <div className="term__bar">
        <div className="log__title">
          <span>日志 · {envName}</span>
          <span>{statusText}</span>
        </div>
        <div className="log__tools">
          <div className="seg" role="group" aria-label="按阶段筛选">
            <button type="button" className="seg__opt" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部</button>
            {STAGES.map((s) => (
              <button key={s} type="button" className="seg__opt" aria-pressed={filter === s} onClick={() => setFilter(s)}>
                {STAGE_NAMES[s].slice(0, 2)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="log__tool"
            aria-pressed={follow}
            onClick={() => {
              if (!follow) ref.current?.scrollToIndex({ index: "LAST", behavior: "auto" });
              setFollow(!follow);
            }}
          >
            <span className="log__led" aria-hidden="true" />自动滚动
          </button>
          <a className="log__tool" href={api.downloadLogUrl(deploymentId, envIdx)} download>
            下载日志
          </a>
        </div>
      </div>
      <div className="log__viewport">
        {visible.length === 0 ? (
          <div className="log__empty">
            {live && lines.length === 0 ? "等待输出…" : filter !== "all" ? `「${STAGE_NAMES[filter]}」阶段没有日志` : "没有日志"}
          </div>
        ) : (
          <Virtuoso
            // Remount per filter so the initial scroll targets the filtered list.
            key={filter}
            ref={ref}
            data={visible}
            style={{ height: "100%" }}
            // "auto" only follows while the view is at the bottom, so scrolling
            // up to read pauses it without extra bookkeeping.
            followOutput={follow ? "auto" : false}
            initialTopMostItemIndex={Math.max(0, visible.length - 1)}
            components={{
              Header: () =>
                skipped + trimmed > 0 ? (
                  <div className="log__skipped">… 前面还有 {skipped + trimmed} 行，完整内容请下载日志</div>
                ) : null,
            }}
            itemContent={(_, line) => <Line line={line} highlightErr={failedStage !== null} />}
          />
        )}
      </div>
    </section>
  );
}
