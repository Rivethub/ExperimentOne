import { useEffect, useRef, type ReactElement } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function QuotaChart({
  recorded,
  projected,
  color,
  empty,
  emptyLabel,
  legend,
}: {
  recorded: number[];
  projected?: number[];
  color: string;
  empty?: boolean;
  emptyLabel?: string;
  legend?: string;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (empty === true) {
      plotRef.current?.destroy();
      plotRef.current = null;
      return;
    }

    const host = hostRef.current;
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

    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, data, host);

    const ro = new ResizeObserver(() => {
      const plot = plotRef.current;
      if (!plot || !hostRef.current) {
        return;
      }
      plot.setSize({
        width: Math.max(hostRef.current.clientWidth || 640, 120),
        height: 160,
      });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [recorded, projected, color, empty, legend]);

  if (empty === true) {
    return (
      <div className={cx(styles.chartWrap, styles.chartWrapEmpty)}>
        <p>{emptyLabel ?? "No captures in this window"}</p>
      </div>
    );
  }

  return (
    <div className={styles.chartWrap}>
      <div ref={hostRef} className={styles.chartUplotHost} />
      <div className={styles.chartLegend} style={{ color }}>
        <span>
          <i className={styles.swatch} /> {legend ?? "Measured capture burn"}
        </span>
      </div>
    </div>
  );
}
