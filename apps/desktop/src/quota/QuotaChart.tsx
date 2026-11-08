import { cx } from "../styles/cx";
import styles from "../styles/app.module.css";

export function QuotaChart({
  recorded,
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
}) {
  if (empty) {
    return (
      <div className={cx(styles.chartWrap, styles.chartWrapEmpty)}>
        <p>{emptyLabel ?? "No captured traffic in this window"}</p>
      </div>
    );
  }

  const w = 640;
  const h = 160;
  const pad = 8;
  const nowIdx = Math.max(0, recorded.length - 1);

  const toPath = (vals: number[], from: number, to: number) => {
    const slice = vals.slice(from, to + 1);
    return slice
      .map((v, i) => {
        const x = pad + ((from + i) / (vals.length - 1)) * (w - pad * 2);
        const y = pad + (1 - v / 100) * (h - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const area = (() => {
    const line = toPath(recorded, 0, nowIdx);
    const x0 = pad;
    const x1 = pad + (nowIdx / (recorded.length - 1)) * (w - pad * 2);
    const yBase = h - pad;
    return `${line} L${x1},${yBase} L${x0},${yBase} Z`;
  })();

  const nowX = pad + (nowIdx / (recorded.length - 1)) * (w - pad * 2);

  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {[0, 25, 50, 75, 100].map((tick) => {
          const y = pad + (1 - tick / 100) * (h - pad * 2);
          return (
            <line key={tick} x1={pad} x2={w - pad} y1={y} y2={y} stroke="#1f1f23" strokeWidth="1" />
          );
        })}
        <path d={area} fill={color} opacity="0.12" />
        <path
          d={toPath(recorded, 0, nowIdx)}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line
          x1={nowX}
          x2={nowX}
          y1={pad}
          y2={h - pad}
          stroke="#fafafa"
          strokeWidth="1"
          opacity="0.35"
        />
        <text
          x={Math.max(pad, nowX - 28)}
          y={pad + 10}
          fill="#a1a1aa"
          fontSize="10"
          fontFamily="DM Sans, sans-serif"
        >
          Now
        </text>
      </svg>
      <div className={styles.chartLegend} style={{ color }}>
        <span>
          <i className={styles.swatch} /> {legend ?? "Measured traffic burn"}
        </span>
      </div>
    </div>
  );
}
