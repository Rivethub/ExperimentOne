import { createVirtualizer } from "@tanstack/solid-virtual";
import { Brain, ChevronRight, Terminal, Wrench } from "lucide-solid";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";
import { reasoningPreview } from "./timeline";
import { ToolDiff } from "./ToolDiff";
import type { AgentContext, TimelineItem } from "./types";

function shortAgentId(id: string): string {
  const t = id.trim();
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

function AgentBadge({ agent }: { agent?: AgentContext }) {
  if (!agent?.agent_id && !agent?.request_class && !agent?.agent_type) return null;
  const label =
    agent.agent_type?.trim() ||
    (agent.request_class && agent.request_class !== "main"
      ? agent.request_class
      : agent.agent_id
        ? "subagent"
        : null);
  if (!label) return null;
  const tip = [
    agent.agent_id ? `agent ${agent.agent_id}` : null,
    agent.parent_agent_id ? `parent ${agent.parent_agent_id}` : null,
    agent.request_class ? `class ${agent.request_class}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span class={styles.t3AgentBadge} title={tip || undefined}>
      {label}
      {agent.agent_id ? ` · ${shortAgentId(agent.agent_id)}` : ""}
    </span>
  );
}

const TRANSCRIPT_REMARK = [remarkGfm, remarkBreaks];
const TRANSCRIPT_REHYPE = [rehypeSanitize];

function formatJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <div class={styles.t3Markdown}>
      <SolidMarkdown remarkPlugins={TRANSCRIPT_REMARK} rehypePlugins={TRANSCRIPT_REHYPE}>
        {text}
      </SolidMarkdown>
    </div>
  );
}

function WorkRow({
  icon,
  label,
  meta,
  open,
  onToggle,
  tone = "default",
  children,
}: {
  icon: JSX.Element;
  label: JSX.Element;
  meta?: JSX.Element;
  open: boolean;
  onToggle: () => void;
  tone?: "default" | "think" | "cmd" | "tool" | "error";
  children?: JSX.Element;
}) {
  const toneClass =
    tone === "think"
      ? styles.t3RowThink
      : tone === "cmd"
        ? styles.t3RowCmd
        : tone === "tool"
          ? styles.t3RowTool
          : tone === "error"
            ? styles.t3RowError
            : undefined;
  return (
    <div class={cx(styles.t3Row, toneClass)} data-open={open ? "1" : "0"}>
      <button type="button" class={styles.t3RowHead} onClick={onToggle} aria-expanded={open}>
        <span class={styles.t3RowIcon} aria-hidden>
          {icon}
        </span>
        <span class={styles.t3RowLabel}>{label}</span>
        {meta ? <span class={styles.t3RowMeta}>{meta}</span> : null}
        <ChevronRight
          class={cx(styles.t3Chevron, open && styles.t3ChevronOpen)}
          size={14}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      {open && children ? <div class={styles.t3RowBody}>{children}</div> : null}
    </div>
  );
}

function UserMessage({ item }: { item: Extract<TimelineItem, { kind: "user_message" }> }) {
  return (
    <div class={styles.t3User}>
      <AgentBadge agent={item.agent} />
      <MarkdownBody text={item.text} />
    </div>
  );
}

function AssistantMessage({
  item,
}: {
  item: Extract<TimelineItem, { kind: "assistant_message" }>;
}) {
  return (
    <div class={styles.t3Assistant}>
      <AgentBadge agent={item.agent} />
      <MarkdownBody text={item.text} />
    </div>
  );
}

function ReasoningItem({ item }: { item: Extract<TimelineItem, { kind: "reasoning" }> }) {
  const [open, setOpen] = createSignal(false);
  return (
    <WorkRow
      icon={<Brain size={14} strokeWidth={1.75} />}
      label={open() ? "Thought" : reasoningPreview(item.text)}
      meta={<AgentBadge agent={item.agent} />}
      open={open()}
      onToggle={() => setOpen((v) => !v)}
      tone="think"
    >
      <div class={styles.t3ThinkBody}>
        <MarkdownBody text={item.text} />
      </div>
    </WorkRow>
  );
}

function CommandItem({ item }: { item: Extract<TimelineItem, { kind: "command_execution" }> }) {
  const [open, setOpen] = createSignal(false);
  const oneLine = item.command.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 88 ? `${oneLine.slice(0, 88)}…` : oneLine;
  return (
    <WorkRow
      icon={<Terminal size={14} strokeWidth={1.75} />}
      label={<span class={styles.t3CmdLabel}>{short}</span>}
      meta={
        <>
          <AgentBadge agent={item.agent} />
          {item.exitCode != null ? (
            <span class={item.isError ? styles.t3Bad : styles.t3Ok}>exit {item.exitCode}</span>
          ) : item.isError ? (
            <span class={styles.t3Bad}>failed</span>
          ) : null}
        </>
      }
      open={open()}
      onToggle={() => setOpen((v) => !v)}
      tone={item.isError ? "error" : "cmd"}
    >
      <div class={styles.t3Terminal}>
        <pre class={styles.t3TerminalCmd}>{item.command}</pre>
        {item.output ? <pre class={styles.t3TerminalOut}>{item.output}</pre> : null}
      </div>
    </WorkRow>
  );
}

function ToolJsonOrDiff({ label, value }: { label: string; value: unknown }): JSX.Element {
  const diff = <ToolDiff value={value} />;
  return (
    <div>
      <div class={styles.t3ToolCaption}>{label}</div>
      {diff ?? <pre class={styles.t3ToolPre}>{formatJson(value)}</pre>}
    </div>
  );
}

function ToolItem({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [open, setOpen] = createSignal(false);
  return (
    <WorkRow
      icon={<Wrench size={14} strokeWidth={1.75} />}
      label={item.title}
      meta={
        <>
          <AgentBadge agent={item.agent} />
          {item.isError ? <span class={styles.t3Bad}>error</span> : null}
        </>
      }
      open={open()}
      onToggle={() => setOpen((v) => !v)}
      tone={item.isError ? "error" : "tool"}
    >
      <div class={styles.t3ToolBlocks}>
        <ToolJsonOrDiff label="Input" value={item.input} />
        {item.output !== undefined && (
          <ToolJsonOrDiff label={item.isError ? "Error" : "Output"} value={item.output} />
        )}
      </div>
    </WorkRow>
  );
}

function SystemItem({ item }: { item: Extract<TimelineItem, { kind: "system" }> }) {
  return (
    <div class={styles.t3System}>
      <MarkdownBody text={item.text} />
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "user_message":
      return <UserMessage item={item} />;
    case "assistant_message":
      return <AssistantMessage item={item} />;
    case "reasoning":
      return <ReasoningItem item={item} />;
    case "command_execution":
      return <CommandItem item={item} />;
    case "tool":
      return <ToolItem item={item} />;
    case "system":
      return <SystemItem item={item} />;
  }
}

export function TranscriptView({ items }: { items: TimelineItem[] }) {
  let parentRef: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef ?? null,
    estimateSize: () => 120,
    overscan: 8,
    getItemKey: (index) => items[index]?.id ?? index,
  });

  if (items.length === 0) return null;

  return (
    <div
      ref={(el) => {
        parentRef = el;
      }}
      class={styles.t3Timeline}
    >
      <div class={styles.t3VirtualInner} style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]!;
          const style = {
            transform: `translateY(${row.start}px)`,
          } satisfies JSX.CSSProperties;
          return (
            <div
              data-index={row.index}
              ref={virtualizer.measureElement}
              class={cx(styles.t3Item, styles.t3VirtualRow)}
              style={style}
            >
              <TimelineRow item={item} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
