import type { AppConfig, Channel } from "../config/schema.js";
import type { ShockPlan } from "./types.js";

export type SafetyBlockReason =
  | "panic"
  | "unarmed"
  | "no_channel"
  | "rate_limit"
  | "min_interval"
  | "session_expired";

export interface SafetyStatus {
  dryRun: boolean;
  armed: boolean;
  panic: boolean;
  channelLimits: Record<Channel, number>;
  effectiveLimits: Record<Channel, number>;
  deviceSoftLimits?: Record<Channel, number>;
  maxContinuousOutputMs: number;
  maxEventsPerMinute: number;
  recentEventsInWindow: number;
  maxIntensityStep: number;
  minIntervalMs: number;
  maxSessionMs: number;
  idleDisarmMs: number;
  armedForMs?: number;
  sessionRemainingMs?: number;
  idleRemainingMs?: number;
  lastIntensity: Record<Channel, number>;
  lastBlockReason?: SafetyBlockReason;
}

export interface SafetySettingsPatch {
  channelLimits?: Partial<Record<Channel, number>>;
  maxContinuousOutputMs?: number;
  maxEventsPerMinute?: number;
  maxIntensityStep?: number;
  minIntervalMs?: number;
  maxSessionMs?: number;
  idleDisarmMs?: number;
  respectDeviceSoftLimit?: boolean;
}

export type AutoDisarmReason = "session_expired" | "idle_timeout" | "link_lost";

type AutoDisarmListener = (reason: AutoDisarmReason) => void;

const CHANNELS: Channel[] = ["A", "B"];

/**
 * Central gate every real device output must pass through.
 *
 * Layers, in order: panic latch, arm state, session/idle expiry, per-channel
 * minimum interval, sliding-window rate limit, absolute intensity ceiling
 * (config limit intersected with the device-reported soft limit), and a
 * per-channel ramp cap so intensity can never step straight to the ceiling.
 */
export class SafetyGate {
  private dryRun: boolean;
  private armed: boolean;
  private panicState = false;
  private readonly eventTimes: number[] = [];
  private readonly lastPlanAt: Record<Channel, number> = { A: 0, B: 0 };
  private readonly lastIntensity: Record<Channel, number> = { A: 0, B: 0 };
  private deviceSoftLimits?: Record<Channel, number>;
  private armedAt?: number;
  private lastActivityAt?: number;
  private lastBlockReason?: SafetyBlockReason;
  private watchdog?: NodeJS.Timeout;
  private readonly autoDisarmListeners = new Set<AutoDisarmListener>();

  constructor(private readonly config: AppConfig["safety"]) {
    this.dryRun = config.dry_run;
    this.armed = config.armed;
    if (this.armed) {
      this.beginSession(Date.now());
    }
  }

  onAutoDisarm(listener: AutoDisarmListener): () => void {
    this.autoDisarmListeners.add(listener);
    return () => this.autoDisarmListeners.delete(listener);
  }

  arm(now = Date.now()): void {
    this.armed = true;
    this.panicState = false;
    this.lastBlockReason = undefined;
    this.resetRamp();
    this.beginSession(now);
  }

  disarm(): void {
    this.armed = false;
    this.endSession();
    this.resetRamp();
  }

  panic(): ShockPlan[] {
    this.panicState = true;
    this.armed = false;
    this.endSession();
    this.resetRamp();
    this.lastBlockReason = "panic";
    return [
      { kind: "shock.zero", channel: "A", intensity: 0, durationMs: 0, reason: "panic" },
      { kind: "shock.zero", channel: "B", intensity: 0, durationMs: 0, reason: "panic" }
    ];
  }

  setDryRun(value: boolean): void {
    this.dryRun = value;
    this.resetRamp();
  }

  /**
   * Strength limits the DG-LAB app reports for itself. They are intersected
   * with the local channel limits so a user-set device limit always wins when
   * it is stricter than the config.
   */
  setDeviceSoftLimits(limits: { A: number; B: number } | undefined): void {
    this.deviceSoftLimits = limits ? { A: limits.A, B: limits.B } : undefined;
  }

  /** Called when the DG-LAB link drops so an armed session cannot outlive it. */
  notifyLinkLost(): void {
    this.resetRamp();
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.endSession();
    this.emitAutoDisarm("link_lost");
  }

  updateSettings(patch: SafetySettingsPatch): void {
    if (patch.channelLimits?.A !== undefined) {
      this.config.channel_limits.A = clampInteger(patch.channelLimits.A, 0, 100);
    }
    if (patch.channelLimits?.B !== undefined) {
      this.config.channel_limits.B = clampInteger(patch.channelLimits.B, 0, 100);
    }
    if (patch.maxContinuousOutputMs !== undefined) {
      this.config.max_continuous_output_ms = clampInteger(patch.maxContinuousOutputMs, 1, 30_000);
    }
    if (patch.maxEventsPerMinute !== undefined) {
      this.config.max_events_per_minute = clampInteger(patch.maxEventsPerMinute, 1, 600);
    }
    if (patch.maxIntensityStep !== undefined) {
      this.config.max_intensity_step = clampNumber(patch.maxIntensityStep, 0.01, 1);
    }
    if (patch.minIntervalMs !== undefined) {
      this.config.min_interval_ms = clampInteger(patch.minIntervalMs, 0, 10_000);
    }
    if (patch.maxSessionMs !== undefined) {
      this.config.max_session_ms = clampInteger(patch.maxSessionMs, 0, 6 * 3_600_000);
    }
    if (patch.idleDisarmMs !== undefined) {
      this.config.idle_disarm_ms = clampInteger(patch.idleDisarmMs, 0, 3_600_000);
    }
    if (patch.respectDeviceSoftLimit !== undefined) {
      this.config.respect_device_soft_limit = patch.respectDeviceSoftLimit;
    }
    this.restartWatchdog();
  }

  getStatus(now = Date.now()): SafetyStatus {
    this.prune(now);
    this.enforceSessionWindow(now);

    const status: SafetyStatus = {
      dryRun: this.dryRun,
      armed: this.armed,
      panic: this.panicState,
      channelLimits: { ...this.config.channel_limits },
      effectiveLimits: {
        A: Math.round(this.effectiveLimit("A") * 100),
        B: Math.round(this.effectiveLimit("B") * 100)
      },
      deviceSoftLimits: this.deviceSoftLimits ? { ...this.deviceSoftLimits } : undefined,
      maxContinuousOutputMs: this.config.max_continuous_output_ms,
      maxEventsPerMinute: this.config.max_events_per_minute,
      recentEventsInWindow: this.eventTimes.length,
      maxIntensityStep: this.config.max_intensity_step,
      minIntervalMs: this.config.min_interval_ms,
      maxSessionMs: this.config.max_session_ms,
      idleDisarmMs: this.config.idle_disarm_ms,
      lastIntensity: { ...this.lastIntensity },
      lastBlockReason: this.lastBlockReason
    };

    if (this.armed && this.armedAt !== undefined) {
      status.armedForMs = now - this.armedAt;
      if (this.config.max_session_ms > 0) {
        status.sessionRemainingMs = Math.max(0, this.config.max_session_ms - (now - this.armedAt));
      }
      if (this.config.idle_disarm_ms > 0 && this.lastActivityAt !== undefined) {
        status.idleRemainingMs = Math.max(0, this.config.idle_disarm_ms - (now - this.lastActivityAt));
      }
    }

    return status;
  }

  evaluate(plan: ShockPlan, now = Date.now()): ShockPlan | undefined {
    // Zero and clear are the de-escalation path; they must never be gated,
    // but they do reset the ramp baseline so the next plan starts from zero.
    if (plan.kind === "shock.zero" || plan.kind === "shock.clear") {
      if (plan.channel) {
        this.lastIntensity[plan.channel] = 0;
      } else {
        this.resetRamp();
      }
      return plan;
    }

    if (this.panicState) {
      return this.block("panic");
    }

    this.enforceSessionWindow(now);

    if (!this.dryRun && !this.armed) {
      return this.block("unarmed");
    }

    if (!plan.channel) {
      return this.block("no_channel");
    }

    const channel = plan.channel;

    // Continuous stream plans are already throttled upstream by the engine and
    // are refreshes of one ongoing output, so the per-plan spacing rule would
    // only fight that throttle.
    if (!plan.continuous && this.config.min_interval_ms > 0) {
      const sinceLast = now - this.lastPlanAt[channel];
      if (this.lastPlanAt[channel] > 0 && sinceLast < this.config.min_interval_ms) {
        return this.block("min_interval");
      }
    }

    this.prune(now);
    if (this.eventTimes.length >= this.config.max_events_per_minute) {
      return this.block("rate_limit");
    }

    const ceiling = this.effectiveLimit(channel);
    const ramped = Math.min(plan.intensity, this.lastIntensity[channel] + this.config.max_intensity_step);
    // The ramp feeds its own output back in, so round to keep repeated
    // additions from drifting away from the intended step size.
    const safeIntensity = roundIntensity(Math.max(0, Math.min(ramped, ceiling)));
    const safeDuration = Math.min(plan.durationMs, this.config.max_continuous_output_ms);

    this.eventTimes.push(now);
    this.lastPlanAt[channel] = now;
    this.lastIntensity[channel] = safeIntensity;
    this.lastActivityAt = now;
    this.lastBlockReason = undefined;

    return {
      ...plan,
      intensity: safeIntensity,
      durationMs: safeDuration
    };
  }

  /**
   * Stops the watchdog and leaves the gate closed. Disarming here matters:
   * endSession() alone would clear armedAt, which makes enforceSessionWindow a
   * no-op and would leave a permanently armed, un-expirable gate behind.
   */
  dispose(): void {
    this.armed = false;
    this.endSession();
    this.resetRamp();
    this.autoDisarmListeners.clear();
  }

  private effectiveLimit(channel: Channel): number {
    const configured = this.config.channel_limits[channel] / 100;
    if (!this.config.respect_device_soft_limit || !this.deviceSoftLimits) {
      return configured;
    }
    const device = this.deviceSoftLimits[channel];
    if (!Number.isFinite(device) || device <= 0) {
      return configured;
    }
    return Math.min(configured, device / 100);
  }

  private block(reason: SafetyBlockReason): undefined {
    this.lastBlockReason = reason;
    return undefined;
  }

  private beginSession(now: number): void {
    this.armedAt = now;
    this.lastActivityAt = now;
    this.restartWatchdog();
  }

  private endSession(): void {
    this.armedAt = undefined;
    this.lastActivityAt = undefined;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private restartWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    if (!this.armed) {
      return;
    }
    if (this.config.max_session_ms <= 0 && this.config.idle_disarm_ms <= 0) {
      return;
    }
    // A quiet session produces no events, so expiry cannot be discovered
    // lazily inside evaluate(); this ticker is what makes idle-disarm real.
    this.watchdog = setInterval(() => this.enforceSessionWindow(Date.now()), 1000);
    this.watchdog.unref?.();
  }

  private enforceSessionWindow(now: number): void {
    if (!this.armed || this.armedAt === undefined) {
      return;
    }

    if (this.config.max_session_ms > 0 && now - this.armedAt >= this.config.max_session_ms) {
      this.armed = false;
      this.endSession();
      this.resetRamp();
      this.lastBlockReason = "session_expired";
      this.emitAutoDisarm("session_expired");
      return;
    }

    if (
      this.config.idle_disarm_ms > 0 &&
      this.lastActivityAt !== undefined &&
      now - this.lastActivityAt >= this.config.idle_disarm_ms
    ) {
      this.armed = false;
      this.endSession();
      this.resetRamp();
      this.emitAutoDisarm("idle_timeout");
    }
  }

  private emitAutoDisarm(reason: AutoDisarmReason): void {
    for (const listener of this.autoDisarmListeners) {
      try {
        listener(reason);
      } catch (error) {
        console.error(JSON.stringify({ kind: "safety.auto_disarm_listener_error", reason, message: String(error) }));
      }
    }
  }

  private resetRamp(): void {
    for (const channel of CHANNELS) {
      this.lastIntensity[channel] = 0;
    }
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.eventTimes.length > 0 && this.eventTimes[0] < cutoff) {
      this.eventTimes.shift();
    }
  }
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundIntensity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
