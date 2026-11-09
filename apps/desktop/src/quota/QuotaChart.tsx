import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { Card, CardContent } from "#components/ui/card";
import { cx, styles } from "#styles";

export function QuotaChart(props: {
  recorded: number[];
  projected?: number[];
  color: string;
  empty?: boolean;
  emptyLabel?: string;
  legend?: string;
}): JSX.Element {
  const [hostEl, setHostEl] = createSignal<HTMLDivElement | undefined>();
  let plotRef: uPlot | undefined;

  createEffect(() => {
    const empty = props.empty;
    const recorded = props.recorded;
    const projected = props.projected;
    const color = props.color;
    const legend = props.legend;
    const host = hostEl();

    if (empty === true) {
      plotRef?.destroy();
      plotRef = undefined;
      return;
    }

    if (!host) {
      return;
    }

    const xs = recorded.map((_, i) => i);
    const data: uPlot.AlignedData =
      projected && projected.length === recorded.length
        ? [xs, recorded, projected]
        : [xs, recorded];

    const series: uPlot.Series[] = [
      {},
      {
        label: legend ?? "Measured capture burn",
        stroke: color,
        width: 2,
        fill: `${color}1f`,
        points: { show: false },
      },
    ];
    if (projected && projected.length === recorded.length) {
      series.push({
        label: "Projected",
        stroke: color,
        width: 1.5,
        dash: [4, 4],
        points: { show: false },
      });
    }

    const opts: uPlot.Options = {
      width: Math.max(host.clientWidth || 640, 120),
      height: 160,
      class: styles.chartUplot,
      legend: { show: false },
      cursor: { show: false },
      scales: {
        x: { time: false },
        y: { auto: false, range: [0, 100] },
      },
      axes: [
        { show: false },
        {
          show: true,
          stroke: "#52525b",
          grid: { stroke: "#1f1f23", width: 1 },
          ticks: { show: false },
          values: (_u, vals) => vals.map((v) => (v === 0 || v === 50 || v === 100 ? `${v}` : "")),
          size: 28,
          font: "10px DM Sans, sans-serif",
        },
      ],
      series,
      hooks: {
        draw: [
          (u) => {
            const nowIdx = Math.max(0, recorded.length - 1);
            const x = u.valToPos(nowIdx, "x", true);
            const top = u.bbox.top;
            const bottom = u.bbox.top + u.bbox.height;
            const { ctx } = u;
            ctx.save();
            ctx.strokeStyle = "rgba(250, 250, 250, 0.35)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
            ctx.stroke();
            ctx.fillStyle = "#a1a1aa";
            ctx.font = "10px DM Sans, sans-serif";
            ctx.fillText("Now", Math.max(u.bbox.left, x - 28), top + 12);
            ctx.restore();
          },
        ],
      },
    };

    plotRef?.destroy();
    plotRef = new uPlot(opts, data, host);

    const ro = new ResizeObserver(() => {
      const plot = plotRef;
      const currentHost = hostEl();
      if (!plot || !currentHost) {
        return;
      }
      plot.setSize({
        width: Math.max(currentHost.clientWidth || 640, 120),
        height: 160,
      });
    });
    ro.observe(host);

    onCleanup(() => {
      ro.disconnect();
      plotRef?.destroy();
      plotRef = undefined;
    });
  });

  return (
    <Card class="gap-0 border-border/60 bg-transparent py-0 shadow-none">
      <CardContent class="p-0">
        <Show
          when={props.empty !== true}
          fallback={
            <div class={cx(styles.chartWrap, styles.chartWrapEmpty)}>
              <p>{props.emptyLabel ?? "No captures in this window"}</p>
            </div>
          }
        >
          <div class={styles.chartWrap}>
            <div ref={setHostEl} class={styles.chartUplotHost} />
            <div class={styles.chartLegend} style={{ color: props.color }}>
              <span>
                <i class={styles.swatch} /> {props.legend ?? "Measured capture burn"}
              </span>
            </div>
          </div>
        </Show>
      </CardContent>
    </Card>
  );
}
