import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config/loadConfig.js";
import type { AppConfig } from "../config/schema.js";
import { DglabController } from "../dglab/controller.js";
import { startLocalDglabRelay, type DglabRelayServer } from "../dglab/relay.js";
import { DglabSink } from "../dglab/sink.js";
import { WaveformRegistry } from "../dglab/waves.js";
import { EventBus } from "../events/bus.js";
import { buildServer } from "../proxy/server.js";
import { DryRunSink } from "../shock/dryRunSink.js";
import { ShockEngine } from "../shock/engine.js";
import { ShockPlanStore } from "../shock/planStore.js";
import { ShockPolicy } from "../shock/policy.js";
import { SafetyGate } from "../shock/safety.js";
import type { CoyoteAppContext } from "./context.js";

export interface CoyoteRuntime {
  app: FastifyInstance;
  context: CoyoteAppContext;
  /** Zeroes the device and tears everything down. Safe to call more than once. */
  close: () => Promise<void>;
  /**
   * Best-effort zero of both channels without shutting the process down.
   * Resolves to whether the zero actually reached the device.
   */
  emergencyZero: () => Promise<boolean>;
}

export async function createCoyoteRuntime(config: AppConfig = loadConfig()): Promise<CoyoteRuntime> {
  const bus = new EventBus(config.privacy.recent_event_limit);
  const safety = new SafetyGate(config.safety);
  const policy = new ShockPolicy(config.policy);
  const waveforms = new WaveformRegistry();
  const dglabRelay = config.dglab.enabled ? await startLocalDglabRelay(config.dglab) : undefined;
  const dglab = config.dglab.enabled ? new DglabController(config.dglab, bus) : undefined;
  const sink = dglab ? new DglabSink(dglab, waveforms) : new DryRunSink();
  const shockPlans = new ShockPlanStore(config.privacy.recent_event_limit);

  const emergencyZero = async (): Promise<boolean> => {
    dglabRelay?.cancelAllPulses();
    return zeroDevice(dglab);
  };

  const context: CoyoteAppContext = {
    config,
    bus,
    safety,
    policy,
    dglab,
    shockPlans,
    waveforms,
    emergencyZero
  };

  const engine = new ShockEngine(bus, policy, safety, sink, shockPlans);
  context.sendPlan = (plan) => engine.sendGatedPlan(plan);

  // An armed session must not outlive the link that carries its output, and an
  // auto-disarm must actually reach the hardware rather than only flipping a
  // flag in memory.
  safety.onAutoDisarm((reason) => {
    console.warn(JSON.stringify({ kind: "safety.auto_disarm", reason }));
    bus.emit({ type: "safety.disarmed", timestamp: Date.now() });
    // Same order as the manual stop paths: recall queued pulses first, then
    // zero. Zeroing alone would leave already-scheduled forwards firing.
    void emergencyZero();
  });

  bus.onEvent((event) => {
    if (event.type === "dglab.disconnected") {
      // The reported soft limits belonged to the device that just went away.
      safety.setDeviceSoftLimits(undefined);
      safety.notifyLinkLost();
      return;
    }
    if (event.type === "dglab.strength_report") {
      const strengths = dglab?.getStatus().strengths;
      safety.setDeviceSoftLimits(
        strengths ? { A: strengths.softLimitA, B: strengths.softLimitB } : undefined
      );
    }
  });

  const app = buildServer(context);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await shutdownRuntime({ app, engine, safety, dglab, dglabRelay, panicOnExit: config.safety.panic_zero_on_exit });
  };

  return { app, context, close, emergencyZero };
}

interface ShutdownInput {
  app: FastifyInstance;
  engine: ShockEngine;
  safety: SafetyGate;
  dglab: DglabController | undefined;
  dglabRelay: DglabRelayServer | undefined;
  panicOnExit: boolean;
}

/**
 * Order matters: stop accepting new plans, let queued sends settle, recall
 * queued pulse forwards, zero the device, and only then drop the transports.
 */
async function shutdownRuntime(input: ShutdownInput): Promise<void> {
  const { app, engine, safety, dglab, dglabRelay, panicOnExit } = input;

  // Close the gate and let queued work settle regardless of panic_zero_on_exit.
  // That setting governs whether we actively zero, not whether we may keep
  // emitting on the way out — draining after a zero would undo it.
  safety.panic();
  dglabRelay?.cancelAllPulses();
  await withTimeout(engine.drain(), 2000, "engine drain");

  if (panicOnExit) {
    await withTimeout(zeroDevice(dglab), 2000, "device zero");
  }

  safety.dispose();
  // disconnect() zeroes again on its way out, which is the belt-and-braces
  // path for the case where panic_zero_on_exit is disabled.
  await withTimeout(dglab?.disconnect() ?? Promise.resolve(), 2000, "dglab disconnect");
  // Give the relay a moment to forward the zero on to the app before its
  // sockets are torn down; otherwise the last command can be dropped in flight.
  if (dglabRelay) {
    await settle(RELAY_DRAIN_MS);
  }
  await withTimeout(dglabRelay?.close() ?? Promise.resolve(), 2000, "relay close");
  await app.close();
}

const RELAY_DRAIN_MS = 150;

async function settle(ms: number): Promise<void> {
  // Deliberately not unref'd: this wait exists so the zero actually reaches the
  // device, and an unref'd timer could let the process exit straight through it.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Resolves to whether a zero actually reached the device. */
async function zeroDevice(dglab: DglabController | undefined): Promise<boolean> {
  if (!dglab) {
    return false;
  }
  try {
    return await dglab.zeroAll();
  } catch (error) {
    console.error(JSON.stringify({ kind: "dglab.zero_failed", message: String(error) }));
    return false;
  }
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(JSON.stringify({ kind: "shutdown.timeout", label }));
          resolve();
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    console.error(JSON.stringify({ kind: "shutdown.error", label, message: String(error) }));
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
