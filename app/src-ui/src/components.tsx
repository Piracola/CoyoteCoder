import type React from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type StatusTone = "ok" | "warn" | "danger" | "neutral" | "info";

export function ActionButton({
  children,
  icon,
  busy,
  disabled,
  variant = "primary",
  className = "",
  onClick
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  variant?: ButtonVariant;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button className={`button ${variant} ${className}`.trim()} type="button" disabled={disabled || busy} onClick={onClick}>
      {busy ? <Loader2 className="spin" size={17} /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({
  icon,
  title,
  busy,
  disabled,
  onClick
}: {
  icon: React.ReactNode;
  title: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="icon-button" type="button" title={title} aria-label={title} disabled={disabled || busy} onClick={onClick}>
      {busy ? <Loader2 className="spin" size={17} /> : icon}
    </button>
  );
}

export function StatusPill({ children, tone }: { children: React.ReactNode; tone: StatusTone }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

export function Panel({
  children,
  className = "",
  ariaLabel
}: {
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()} aria-label={ariaLabel}>
      {children}
    </section>
  );
}

export function PanelTitle({
  icon,
  title,
  action,
  children
}: {
  icon: React.ReactNode;
  title: string;
  action?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="panel-title">
      <h2>
        {icon}
        {title}
      </h2>
      <div className="panel-title-actions">
        {action ? <span>{action}</span> : null}
        {children}
      </div>
    </div>
  );
}

export function PageTitle({
  eyebrow,
  title,
  children
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {children ? <div className="page-title-actions">{children}</div> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function MetricCard({
  icon,
  label,
  value,
  tone = "info"
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * Draws a DG-LAB V3 waveform's amplitude envelope. Each bar is one 25ms slot,
 * so the shape read left-to-right is what the device will actually deliver.
 */
export function WaveformChart({
  amplitude,
  height = 56,
  label
}: {
  amplitude: number[];
  height?: number;
  label?: string;
}) {
  if (amplitude.length === 0) {
    return <div className="waveform-chart empty-chart">无法预览此波形</div>;
  }

  const slots = amplitude.slice(0, 200);
  const width = Math.max(slots.length * 3, 60);
  const peak = Math.max(1, ...slots);

  return (
    <figure className="waveform-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label ?? "波形预览"}>
        {slots.map((value, index) => {
          const barHeight = Math.max(1, (value / peak) * (height - 2));
          return (
            <rect
              key={index}
              x={index * 3}
              y={height - barHeight}
              width={2}
              height={barHeight}
              rx={0.8}
              opacity={0.35 + (value / peak) * 0.65}
            />
          );
        })}
      </svg>
      {label ? <figcaption>{label}</figcaption> : null}
    </figure>
  );
}

/** Horizontal gauge with an optional ceiling marker. */
export function MeterBar({
  value,
  max = 100,
  limit,
  tone = "info",
  caption
}: {
  value: number;
  max?: number;
  limit?: number;
  tone?: StatusTone;
  caption?: string;
}) {
  const percent = Math.max(0, Math.min(100, (value / max) * 100));
  const limitPercent = limit === undefined ? undefined : Math.max(0, Math.min(100, (limit / max) * 100));

  return (
    <div className="meter">
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${percent}%` }} />
        {limitPercent !== undefined ? <span className="meter-limit" style={{ left: `${limitPercent}%` }} title={`上限 ${limit}`} /> : null}
      </div>
      {caption ? <small>{caption}</small> : null}
    </div>
  );
}

export function InlineHint({ children, tone = "info" }: { children: React.ReactNode; tone?: StatusTone }) {
  return <p className={`inline-hint ${tone}`}>{children}</p>;
}

export function Toast({ toast }: { toast: { message: string; tone: "ok" | "error" } | null }) {
  return (
    <div className={`toast ${toast ? "show" : ""} ${toast?.tone ?? "ok"}`} role="status" aria-live="polite">
      {toast?.message}
    </div>
  );
}
