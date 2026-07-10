import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MetricItem {
  label: string;
  value: ReactNode;
  detail: string;
  tone?: "default" | "attention" | "positive";
}

export function MetricLedger({ items }: { items: MetricItem[] }) {
  return (
    <dl className="grid overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(41,37,36,0.035)] sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "min-w-0 px-5 py-4 sm:px-6 sm:py-5",
            index > 0 && "border-t border-stone-100 sm:border-t-0 sm:border-l xl:border-t-0",
            index === 2 && "sm:border-l-0 sm:border-t xl:border-l xl:border-t-0",
          )}
        >
          <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-stone-500">
            {item.label}
          </dt>
          <dd className="mt-2 flex items-baseline gap-2.5">
            <span className="tnum text-2xl font-semibold tracking-[-0.035em] text-stone-950">
              {item.value}
            </span>
            <span
              className={cn(
                "truncate text-xs",
                item.tone === "attention" && "text-amber-700",
                item.tone === "positive" && "text-emerald-700",
                (!item.tone || item.tone === "default") && "text-stone-500",
              )}
            >
              {item.detail}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface TrendPoint {
  label: string;
  value: number;
}

export function TrendChart({
  points,
  label,
  emptyLabel = "No activity in this period",
}: {
  points: TrendPoint[];
  label: string;
  emptyLabel?: string;
}) {
  const width = 680;
  const height = 190;
  const pad = { top: 18, right: 16, bottom: 34, left: 26 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const max = Math.max(...points.map((point) => point.value), 1);
  const coords = points.map((point, index) => ({
    ...point,
    x: pad.left + (index / Math.max(points.length - 1, 1)) * chartWidth,
    y: pad.top + chartHeight - (point.value / max) * chartHeight,
  }));
  const path = coords
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const area = coords.length
    ? `${path} L ${coords.at(-1)?.x} ${pad.top + chartHeight} L ${coords[0]?.x} ${pad.top + chartHeight} Z`
    : "";
  const hasActivity = points.some((point) => point.value > 0);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        {[0, 0.5, 1].map((tick) => {
          const y = pad.top + chartHeight * tick;
          return (
            <line
              key={tick}
              x1={pad.left}
              x2={width - pad.right}
              y1={y}
              y2={y}
              stroke="oklch(0.923 0.004 75)"
              strokeWidth="1"
            />
          );
        })}
        {hasActivity && (
          <>
            <path d={area} fill="oklch(0.955 0.028 30)" opacity="0.62" />
            <path
              d={path}
              fill="none"
              stroke="oklch(0.46 0.132 24)"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {coords.map((point) => (
              <circle
                key={`${point.label}-${point.x}`}
                cx={point.x}
                cy={point.y}
                r="3.5"
                fill="oklch(0.995 0.003 75)"
                stroke="oklch(0.46 0.132 24)"
                strokeWidth="2"
              />
            ))}
          </>
        )}
        {coords.map((point) => (
          <text
            key={point.label}
            x={point.x}
            y={height - 8}
            textAnchor="middle"
            fill="oklch(0.553 0.01 60)"
            fontSize="11"
            fontFamily="var(--font-geist-sans)"
          >
            {point.label}
          </text>
        ))}
      </svg>
      {!hasActivity && (
        <p className="absolute inset-x-0 top-[42%] text-center text-sm text-stone-400">
          {emptyLabel}
        </p>
      )}
    </div>
  );
}

export interface DistributionItem {
  label: string;
  value: number;
  colour: string;
}

export function DistributionChart({ items }: { items: DistributionItem[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);

  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-stone-100"
        role="img"
        aria-label={items.map((item) => `${item.label}: ${item.value}`).join(", ")}
      >
        {total > 0 &&
          items.map((item) => (
            <span
              key={item.label}
              style={{ width: `${(item.value / total) * 100}%`, backgroundColor: item.colour }}
            />
          ))}
      </div>
      <dl className="mt-5 space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-3 text-sm">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.colour }}
              aria-hidden
            />
            <dt className="flex-1 text-stone-600">{item.label}</dt>
            <dd className="tnum font-semibold text-stone-900">{item.value}</dd>
            <dd className="tnum w-10 text-right text-xs text-stone-400">
              {total > 0 ? `${Math.round((item.value / total) * 100)}%` : "0%"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
