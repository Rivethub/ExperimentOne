import { Brain, ChevronRight, Terminal, Wrench } from "lucide-solid";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Badge } from "#components/ui/badge";
import { reasoningPreview } from "./timeline";
import { ToolDiff, detectToolDiff } from "./ToolDiff";
import type { AgentContext, TimelineItem } from "./types";
import { cx, styles } from "#styles";

function shortAgentId(id: string): string {
  const t = id.trim();
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

function AgentBadge(props: { agent?: AgentContext }) {
  const agent = () => props.agent;
  const label = () => {
    const a = agent();
    if (!a?.agent_id && !a?.request_class && !a?.agent_type) return null;
    return (
      a.agent_type?.trim() ||
      (a.request_class && a.request_class !== "main"
        ? a.request_class
        : a.agent_id
          ? "subagent"
          : null)
    );
  };
  const tip = () => {
    const a = agent();
    if (!a) return "";
    return [
      a.agent_id ? `agent ${a.agent_id}` : null,
      a.parent_agent_id ? `parent ${a.parent_agent_id}` : null,
      a.request_class ? `class ${a.request_class}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <Show when={label()}>
      {(text) => (
        <Badge
          variant="secondary"
          class="mb-1.5 px-1.5 py-px text-[11px] font-medium tracking-wide text-muted-foreground"
          title={tip() || undefined}
        >
          {text()}
          {agent()?.agent_id ? ` · ${shortAgentId(agent()!.agent_id!)}` : ""}
        </Badge>
      )}
    </Show>
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

function MarkdownBody(props: { text: string }) {
  return (
    <div class={styles.t3Markdown}>
      <SolidMarkdown remarkPlugins={TRANSCRIPT_REMARK} rehypePlugins={TRANSCRIPT_REHYPE}>
        {props.text}
      </SolidMarkdown>
    </div>
  );
}

function WorkRow(props: {
  icon: JSX.Element;
  label: JSX.Element;
  meta?: JSX.Element;
  open: boolean;
  onToggle: () => void;
  tone?: "default" | "think" | "cmd" | "tool" | "error";
  children?: JSX.Element;
}) {
  const toneClass = () => {
    const tone = props.tone ?? "default";
    return tone === "think"
      ? styles.t3RowThink
      : tone === "cmd"
        ? styles.t3RowCmd
        : tone === "tool"
          ? styles.t3RowTool
          : tone === "error"
            ? styles.t3RowError
            : undefined;
  };
  return (
    <div class={cx(styles.t3Row, toneClass())} data-open={props.open ? "1" : "0"}>
      <button
        type="button"
        class={styles.t3RowHead}
        onClick={() => props.onToggle()}
        aria-expanded={props.open}
      >
        <span class={styles.t3RowIcon} aria-hidden>
          {props.icon}
        </span>
        <span class={styles.t3RowLabel}>{props.label}</span>
        <Show when={props.meta}>{(meta) => <span class={styles.t3RowMeta}>{meta()}</span>}</Show>
        <ChevronRight
          class={cx(styles.t3Chevron, props.open && styles.t3ChevronOpen)}
          size={14}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      <Show when={props.open && props.children}>
        <div class={styles.t3RowBody}>{props.children}</div>
      </Show>
    </div>
  );
}

function UserMessage(props: { item: Extract<TimelineItem, { kind: "user_message" }> }) {
  return (
    <div class={styles.t3User}>
      <AgentBadge agent={props.item.agent} />
      <MarkdownBody text={props.item.text} />
    </div>
  );
}

function AssistantMessage(props: { item: Extract<TimelineItem, { kind: "assistant_message" }> }) {
  return (
    <div class={styles.t3Assistant}>
      <AgentBadge agent={props.item.agent} />
      <MarkdownBody text={props.item.text} />
    </div>
  );
}

function ReasoningItem(props: { item: Extract<TimelineItem, { kind: "reasoning" }> }) {
  const [open, setOpen] = createSignal(false);
  return (
    <WorkRow
      icon={<Brain size={14} strokeWidth={1.75} />}
      label={open() ? "Thought" : reasoningPreview(props.item.text)}
      meta={<AgentBadge agent={props.item.agent} />}
      open={open()}
      onToggle={() => setOpen((v) => !v)}
      tone="think"
    >
      <div class={styles.t3ThinkBody}>
        <MarkdownBody text={props.item.text} />
      </div>
    </WorkRow>
  );
}

function CommandItem(props: { item: Extract<TimelineItem, { kind: "command_execution" }> }) {
  const [open, setOpen] = createSignal(false);
  const oneLine = () => props.item.command.replace(/\s+/g, " ").trim();
  const short = () => {
    const line = oneLine();
    return line.length > 88 ? `${line.slice(0, 88)}…` : line;
  };
  return (
    <WorkRow
      icon={<Terminal size={14} strokeWidth={1.75} />}
      label={<span class={styles.t3CmdLabel}>{short()}</span>}
      meta={
        <>
          <AgentBadge agent={props.item.agent} />
          <Show
            when={props.item.exitCode != null}
            fallback={
              <Show when={props.item.isError}>
                <span class={styles.t3Bad}>failed</span>
              </Show>
            }
          >
            <span class={props.item.isError ? styles.t3Bad : styles.t3Ok}>
              exit {props.item.exitCode}
            </span>
          </Show>
        </>
      }
      open={open()}
      onToggle={() => setOpen((v) => !v)}
      tone={props.item.isError ? "error" : "cmd"}
    >
      <div class={styles.t3Terminal}>
        <pre class={styles.t3TerminalCmd}>{props.item.command}</pre>
        <Show when={props.item.output}>
          {(output) => <pre class={styles.t3TerminalOut}>{output()}</pre>}
        </Show>
      </div>
    </WorkRow>
  );
}

/** Tool traces: unified diff when detectable, otherwise formatted JSON/text. */
function ToolJsonOrDiff(props: { label: string; value: unknown }): JSX.Element {
  const detected = () => detectToolDiff(props.value);
  return (
    <div>
      <div class={styles.t3ToolCaption}>{props.label}</div>
      <Show
        when={detected().kind !== "none"}
        fallback={<pre class={styles.t3ToolPre}>{formatJson(props.value)}</pre>}
      >
        <ToolDiff value={props.value} />
      </Show>
    </div>
  );
}

function ToolItem(props: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [open, setOpen] = createSignal(false);
  return (
    <WorkRow
      icon={<Wrench size={14} strokeWidth={1.75} />}
      label={props.item.title}
      meta={
        <>
          <AgentBadge agent={props.item.agent} />
          <Show when={props.item.isError}>
            <span class={styles.t3Bad}>error</span>
          </Show>
        </>
      }
      open={open()}
      onToggle={() => setOpen((v) => !v)}
      tone={props.item.isError ? "error" : "tool"}
    >
      <div class={styles.t3ToolBlocks}>
        <ToolJsonOrDiff label="Input" value={props.item.input} />
        <Show when={props.item.output !== undefined}>
          <ToolJsonOrDiff
            label={props.item.isError ? "Error" : "Output"}
            value={props.item.output}
          />
        </Show>
      </div>
    </WorkRow>
  );
}

function SystemItem(props: { item: Extract<TimelineItem, { kind: "system" }> }) {
  return (
    <div class={styles.t3System}>
      <MarkdownBody text={props.item.text} />
    </div>
  );
}

function TimelineRow(props: { item: TimelineItem }) {
  return (
    <Switch>
      <Match when={props.item.kind === "user_message" ? props.item : false}>
        {(item) => <UserMessage item={item() as Extract<TimelineItem, { kind: "user_message" }>} />}
      </Match>
      <Match when={props.item.kind === "assistant_message" ? props.item : false}>
        {(item) => (
          <AssistantMessage item={item() as Extract<TimelineItem, { kind: "assistant_message" }>} />
        )}
      </Match>
      <Match when={props.item.kind === "reasoning" ? props.item : false}>
        {(item) => <ReasoningItem item={item() as Extract<TimelineItem, { kind: "reasoning" }>} />}
      </Match>
      <Match when={props.item.kind === "command_execution" ? props.item : false}>
        {(item) => (
          <CommandItem item={item() as Extract<TimelineItem, { kind: "command_execution" }>} />
        )}
      </Match>
      <Match when={props.item.kind === "tool" ? props.item : false}>
        {(item) => <ToolItem item={item() as Extract<TimelineItem, { kind: "tool" }>} />}
      </Match>
      <Match when={props.item.kind === "system" ? props.item : false}>
        {(item) => <SystemItem item={item() as Extract<TimelineItem, { kind: "system" }>} />}
      </Match>
    </Switch>
  );
}

/**
 * T3-style conversation activity timeline: messages, thinking traces,
 * shell commands, and tool rows (with diffs when available).
 */
export function TranscriptView(props: { items: TimelineItem[] }) {
  return (
    <Show when={props.items.length > 0}>
      <div class={styles.t3Timeline}>
        <For each={props.items}>
          {(item) => (
            <div class={styles.t3Item}>
              <TimelineRow item={item} />
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
