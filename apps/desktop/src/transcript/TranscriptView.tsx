import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";
import { reasoningPreview } from "./timeline";
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
    <span className={styles.t3AgentBadge} title={tip || undefined}>
      {label}
      {agent.agent_id ? ` · ${shortAgentId(agent.agent_id)}` : ""}
    </span>
  );
}

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
    <div className={styles.t3Markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
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
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  tone?: "default" | "think" | "cmd" | "tool" | "error";
  children?: React.ReactNode;
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
    <div className={cx(styles.t3Row, toneClass)} data-open={open ? "1" : "0"}>
      <button type="button" className={styles.t3RowHead} onClick={onToggle} aria-expanded={open}>
        <span className={styles.t3RowIcon} aria-hidden>
          {icon}
        </span>
        <span className={styles.t3RowLabel}>{label}</span>
        {meta ? <span className={styles.t3RowMeta}>{meta}</span> : null}
        <span className={cx(styles.t3Chevron, open && styles.t3ChevronOpen)} aria-hidden>
          ›
        </span>
      </button>
      {open && children ? <div className={styles.t3RowBody}>{children}</div> : null}
    </div>
  );
}

function BrainIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M9.5 4.5a3 3 0 0 0-2.8 4.1A3.5 3.5 0 0 0 5 11.8c0 1.6.9 3 2.3 3.7V17a2 2 0 0 0 2 2h1" />
      <path d="M14.5 4.5a3 3 0 0 1 2.8 4.1A3.5 3.5 0 0 1 19 11.8c0 1.6-.9 3-2.3 3.7V17a2 2 0 0 1-2 2h-1" />
      <path d="M12 3v18" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M7.5 10.5 10 13l-2.5 2.5" />
      <path d="M12.5 15.5h4" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M14.7 6.3a4 4 0 0 0-5.6 5.6L4 17l3 3 5.1-5.1a4 4 0 0 0 5.6-5.6l-2.5 2.5-2.5-2.5z" />
    </svg>
  );
}

function UserMessage({ item }: { item: Extract<TimelineItem, { kind: "user_message" }> }) {
  return (
    <div className={styles.t3User}>
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
    <div className={styles.t3Assistant}>
      <AgentBadge agent={item.agent} />
      <MarkdownBody text={item.text} />
    </div>
  );
}

function ReasoningItem({ item }: { item: Extract<TimelineItem, { kind: "reasoning" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <WorkRow
      icon={<BrainIcon />}
      label={open ? "Thought" : reasoningPreview(item.text)}
      meta={<AgentBadge agent={item.agent} />}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      tone="think"
    >
      <div className={styles.t3ThinkBody}>
        <MarkdownBody text={item.text} />
      </div>
    </WorkRow>
  );
}

function CommandItem({ item }: { item: Extract<TimelineItem, { kind: "command_execution" }> }) {
  const [open, setOpen] = useState(false);
  const oneLine = item.command.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 88 ? `${oneLine.slice(0, 88)}…` : oneLine;
  return (
    <WorkRow
      icon={<TerminalIcon />}
      label={<span className={styles.t3CmdLabel}>{short}</span>}
      meta={
        <>
          <AgentBadge agent={item.agent} />
          {item.exitCode != null ? (
            <span className={item.isError ? styles.t3Bad : styles.t3Ok}>exit {item.exitCode}</span>
          ) : item.isError ? (
            <span className={styles.t3Bad}>failed</span>
          ) : null}
        </>
      }
      open={open}
      onToggle={() => setOpen((v) => !v)}
      tone={item.isError ? "error" : "cmd"}
    >
      <div className={styles.t3Terminal}>
        <pre className={styles.t3TerminalCmd}>{item.command}</pre>
        {item.output ? <pre className={styles.t3TerminalOut}>{item.output}</pre> : null}
      </div>
    </WorkRow>
  );
}

function ToolItem({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <WorkRow
      icon={<WrenchIcon />}
      label={item.title}
      meta={
        <>
          <AgentBadge agent={item.agent} />
          {item.isError ? <span className={styles.t3Bad}>error</span> : null}
        </>
      }
      open={open}
      onToggle={() => setOpen((v) => !v)}
      tone={item.isError ? "error" : "tool"}
    >
      <div className={styles.t3ToolBlocks}>
        <div>
          <div className={styles.t3ToolCaption}>Input</div>
          <pre className={styles.t3ToolPre}>{formatJson(item.input)}</pre>
        </div>
        {item.output !== undefined && (
          <div>
            <div className={styles.t3ToolCaption}>{item.isError ? "Error" : "Output"}</div>
            <pre className={styles.t3ToolPre}>{formatJson(item.output)}</pre>
          </div>
        )}
      </div>
    </WorkRow>
  );
}

function SystemItem({ item }: { item: Extract<TimelineItem, { kind: "system" }> }) {
  return (
    <div className={styles.t3System}>
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
  if (items.length === 0) return null;
  return (
    <div className={styles.t3Timeline}>
      {items.map((item) => (
        <div key={item.id} className={styles.t3Item}>
          <TimelineRow item={item} />
        </div>
      ))}
    </div>
  );
}
