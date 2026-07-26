import type React from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Link2,
  PlugZap,
  Plus,
  Power,
  QrCode,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Unplug,
  Waves,
  Wifi,
  Zap,
  Play
} from "lucide-react";
import {
  api,
  apiUrl,
  isDesktopRuntime,
  providerFromSummary,
  settingsFromState,
  setRunInBackground,
  type Channel,
  type ChunkPolicy,
  type ProviderDraft,
  type PulsePolicy,
  type SettingsDraft,
  type ShockPlanRecord,
  type UiState,
  type UpstreamProtocol,
  type WaveformState
} from "./api";
import {
  ActionButton,
  EmptyState,
  Field,
  IconButton,
  InlineHint,
  MeterBar,
  MetricCard,
  PageTitle,
  Panel,
  PanelTitle,
  StatusLine,
  StatusPill,
  WaveformChart
} from "./components";
import {
  clampNumber,
  dglabLinkLabel,
  eventDetail,
  eventTypeLabel,
  feedbackLabel,
  matchingPreset,
  newestFirst,
  outputModeLabel,
  planDetail,
  providerPresets,
  summarizeState,
  uniqueProviderId
} from "./helpers";

const TEST_SHOCK_INTENSITY = 0.1;
const TEST_SHOCK_DURATION_MS = 220;

export type ViewId = "overview" | "runtime" | "provider" | "feedback" | "safety" | "logs";
export type RunAction = (key: string, success: string, action: () => Promise<UiState | void>) => Promise<void>;

type ProviderDraftSetter = Dispatch<SetStateAction<ProviderDraft | null>>;
type SettingsDraftSetter = Dispatch<SetStateAction<SettingsDraft | null>>;

export function OverviewView({
  state,
  busy,
  runAction,
  onNavigate,
  onPanic
}: {
  state: UiState;
  busy: string | null;
  runAction: RunAction;
  onNavigate: (view: ViewId) => void;
  onPanic: () => void;
}) {
  const metrics = summarizeState(state);
  const latestEvents = newestFirst(state.events).slice(0, 4);
  const latestPlans = newestFirst(state.shockPlans).slice(0, 4);

  return (
    <div className="page-stack">
      <section className="overview-hero">
        <div className="hero-light" />
        <div className="hero-main">
          <div className="hero-badge">
            <ShieldCheck size={16} />
            本地安全通道
          </div>
          <span className="hero-eyebrow">COYOTECODER CONTROL</span>
          <h1>{feedbackLabel(state)}</h1>
          <p>{state.safety.dryRun ? "当前只记录反馈计划，不会发送真实设备输出。" : "当前允许真实设备输出，请确认设备状态。"}</p>
        </div>
        <div className="hero-meter" aria-label="当前状态">
          <span>{outputModeLabel(state)}</span>
          <strong>
            A {state.dglab.strengths?.A ?? 0}
            <small>/ B {state.dglab.strengths?.B ?? 0}</small>
          </strong>
          <em>{dglabLinkLabel(state)}</em>
        </div>
      </section>

      <div className="metric-grid">
        <MetricCard icon={<Activity size={18} />} label="最近事件" value={metrics.events} tone="info" />
        <MetricCard icon={<Zap size={18} />} label="反馈计划" value={metrics.plans} tone="neutral" />
        <MetricCard icon={<CheckCircle2 size={18} />} label="已发送" value={metrics.sent} tone="ok" />
        <MetricCard icon={<AlertTriangle size={18} />} label="拦截/错误" value={metrics.blocked} tone={metrics.blocked > 0 ? "danger" : "neutral"} />
      </div>

      <div className="dashboard-grid">
        <Panel className="quick-panel">
          <PanelTitle icon={<Power size={18} />} title="快捷操作" action={outputModeLabel(state)} />
          <div className="quick-actions">
            <ActionButton busy={busy === "start"} disabled={state.safety.armed} icon={<Play size={17} />} onClick={() => runAction("start", "反馈已启动", () => api<UiState>("/ui/start", { method: "POST" }))}>
              启动反馈
            </ActionButton>
            <ActionButton
              busy={busy === "stop"}
              disabled={!state.safety.armed && !state.dglab.connected}
              variant="secondary"
              icon={<Square size={17} />}
              onClick={() => runAction("stop", "反馈已停止", () => api<UiState>("/ui/stop", { method: "POST" }))}
            >
              停止反馈
            </ActionButton>
            <ActionButton busy={busy === "panic"} variant="danger" icon={<AlertTriangle size={17} />} onClick={onPanic}>
              紧急停止
            </ActionButton>
            <ActionButton
              busy={busy === "test-shock"}
              disabled={!state.dglab.bound || (!state.safety.dryRun && !state.safety.armed)}
              variant="secondary"
              icon={<PlugZap size={17} />}
              onClick={() =>
                runAction("test-shock", state.safety.dryRun ? "预览测试已记录" : "测试电击已发送", async () =>
                  api<UiState>("/ui/test-shock", {
                    method: "POST",
                    body: JSON.stringify({ channel: "A", intensity: TEST_SHOCK_INTENSITY, durationMs: TEST_SHOCK_DURATION_MS })
                  })
                )
              }
            >
              测试电击
            </ActionButton>
          </div>
        </Panel>

        <Panel className="status-panel">
          <PanelTitle icon={<RadioTower size={18} />} title="连接状态">
            <button className="text-link" type="button" onClick={() => onNavigate("runtime")}>
              进入配对
            </button>
          </PanelTitle>
          <div className="status-slab">
            <StatusLine label="反馈状态" value={feedbackLabel(state)} />
            <StatusLine label="DG-LAB" value={dglabLinkLabel(state)} />
            <StatusLine label="每分钟窗口" value={`${state.safety.recentEventsInWindow ?? 0}/${state.safety.maxEventsPerMinute}`} />
            <StatusLine label="当前供应商" value={state.upstream.name ?? "未配置"} />
          </div>
        </Panel>
      </div>

      <div className="dashboard-grid logs-preview">
        <MiniLog title="最近事件" icon={<Activity size={18} />} items={latestEvents} empty="暂无事件" render={(event) => eventDetail(event)} />
        <MiniLog title="最近计划" icon={<Zap size={18} />} items={latestPlans} empty="暂无计划" render={(plan) => planDetail(plan)} />
      </div>
    </div>
  );
}

function MiniLog<T extends { timestamp: number; type?: string; eventType?: string }>({
  title,
  icon,
  items,
  empty,
  render
}: {
  title: string;
  icon: React.ReactNode;
  items: T[];
  empty: string;
  render: (item: T) => string;
}) {
  return (
    <Panel className="mini-log-panel">
      <PanelTitle icon={icon} title={title} action={`${items.length}`} />
      <div className="log-list compact">
        {items.length === 0 ? (
          <EmptyState>{empty}</EmptyState>
        ) : (
          items.map((item, index) => (
            <div className="log-row" key={`${item.timestamp}-${index}`}>
              <strong>{eventTypeLabel(item.type ?? item.eventType)}</strong>
              <span>{render(item)}</span>
              <time>{new Date(item.timestamp).toLocaleTimeString()}</time>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

export function RuntimeView({
  state,
  busy,
  qrVersion,
  setQrVersion,
  runInBackground,
  setRunInBackgroundState,
  showToast,
  runAction,
  onPanic
}: {
  state: UiState;
  busy: string | null;
  qrVersion: number;
  setQrVersion: (value: number | ((next: number) => number)) => void;
  runInBackground: boolean;
  setRunInBackgroundState: (value: boolean) => void;
  showToast: (message: string, tone?: "ok" | "error") => void;
  runAction: RunAction;
  onPanic: () => void;
}) {
  const qrSrc = state.dglab.qrLink ? apiUrl(`/ui/qr.svg?t=${qrVersion}`) : "";
  const linkTone = state.dglab.bound ? "ok" : state.dglab.connected ? "warn" : "neutral";

  const updateRunInBackground = async (enabled: boolean) => {
    setRunInBackgroundState(enabled);
    try {
      await setRunInBackground(enabled);
      showToast(enabled ? "已开启后台运行" : "已关闭后台运行");
    } catch (error) {
      setRunInBackgroundState(!enabled);
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  return (
    <div className="page-stack">
      <PageTitle eyebrow="Runtime" title="运行与配对">
        <StatusPill tone={state.safety.dryRun ? "warn" : "danger"}>{outputModeLabel(state)}</StatusPill>
        <StatusPill tone={linkTone}>{dglabLinkLabel(state)}</StatusPill>
      </PageTitle>

      <div className="metric-grid three">
        <MetricCard icon={<Power size={18} />} label="反馈状态" value={feedbackLabel(state)} tone={state.safety.armed ? "ok" : "neutral"} />
        <MetricCard icon={<RadioTower size={18} />} label="设备状态" value={dglabLinkLabel(state)} tone={linkTone} />
        <MetricCard icon={<Gauge size={18} />} label="当前强度" value={`A ${state.dglab.strengths?.A ?? 0} / B ${state.dglab.strengths?.B ?? 0}`} tone="info" />
      </div>

      <div className="runtime-grid">
        <Panel>
          <PanelTitle icon={<Power size={18} />} title="运行控制" />
          <div className="command-grid">
            <ActionButton busy={busy === "start"} disabled={state.safety.armed} icon={<Play size={17} />} onClick={() => runAction("start", "反馈已启动", () => api<UiState>("/ui/start", { method: "POST" }))}>
              启动反馈
            </ActionButton>
            <ActionButton
              busy={busy === "stop"}
              disabled={!state.safety.armed && !state.dglab.connected}
              variant="secondary"
              icon={<Square size={17} />}
              onClick={() => runAction("stop", "反馈已停止", () => api<UiState>("/ui/stop", { method: "POST" }))}
            >
              停止反馈
            </ActionButton>
            <ActionButton busy={busy === "panic"} variant="danger" icon={<AlertTriangle size={17} />} onClick={onPanic}>
              紧急停止
            </ActionButton>
            <ActionButton
              busy={busy === "test-shock"}
              disabled={!state.dglab.bound || (!state.safety.dryRun && !state.safety.armed)}
              variant="secondary"
              icon={<PlugZap size={17} />}
              onClick={() =>
                runAction("test-shock", state.safety.dryRun ? "预览测试已记录" : "测试电击已发送", async () =>
                  api<UiState>("/ui/test-shock", {
                    method: "POST",
                    body: JSON.stringify({ channel: "A", intensity: TEST_SHOCK_INTENSITY, durationMs: TEST_SHOCK_DURATION_MS })
                  })
                )
              }
            >
              测试电击
            </ActionButton>
          </div>
          <div className="toggle-grid">
            <RuntimeToggle
              checked={state.safety.dryRun}
              disabled={busy === "preview-mode"}
              title="预览模式"
              detail="只记录计划，不发送真实设备输出"
              onChange={(checked) =>
                runAction("preview-mode", checked ? "预览模式已开启" : "设备输出已开启", () =>
                  api<UiState>("/ui/settings", {
                    method: "POST",
                    body: JSON.stringify({ dryRun: checked })
                  })
                )
              }
            />
            {isDesktopRuntime && <RuntimeToggle checked={runInBackground} title="后台运行" detail="关闭窗口后保留服务" onChange={(checked) => void updateRunInBackground(checked)} />}
          </div>
        </Panel>

        <Panel>
          <PanelTitle icon={<QrCode size={18} />} title="设备配对" action={dglabLinkLabel(state)} />
          <div className="pairing-grid">
            <div className="qr-box">
              {qrSrc ? <img src={qrSrc} alt="DG-LAB 配对二维码" /> : <QrCode size={54} strokeWidth={1.5} />}
            </div>
            <div className="pairing-side">
              <div className="command-grid single">
                <ActionButton
                  busy={busy === "connect"}
                  disabled={!state.dglab.enabled || state.dglab.connected}
                  variant="secondary"
                  icon={<PlugZap size={17} />}
                  onClick={() =>
                    runAction("connect", "DG-LAB 已连接", async () => {
                      await api("/dglab/connect", { method: "POST" });
                      return api<UiState>("/ui/state");
                    })
                  }
                >
                  连接
                </ActionButton>
                <ActionButton
                  busy={busy === "disconnect"}
                  disabled={!state.dglab.connected}
                  variant="secondary"
                  icon={<Unplug size={17} />}
                  onClick={() =>
                    runAction("disconnect", "DG-LAB 已断开", async () => {
                      await api("/dglab/disconnect", { method: "POST" });
                      return api<UiState>("/ui/state");
                    })
                  }
                >
                  断开
                </ActionButton>
                <ActionButton
                  busy={busy === "qr"}
                  disabled={!state.dglab.enabled}
                  icon={<Link2 size={17} />}
                  onClick={() =>
                    runAction("qr", "配对码已更新", async () => {
                      await api("/dglab/qr");
                      setQrVersion((value) => value + 1);
                      return api<UiState>("/ui/state");
                    })
                  }
                >
                  生成配对码
                </ActionButton>
              </div>
              <div className={`link-state ${linkTone}`}>
                <strong>{state.dglab.bound ? "APP 已绑定" : state.dglab.connected ? "等待扫码绑定" : "等待 Socket 连接"}</strong>
                <span>{state.dglab.bound ? "预览与受控测试可用" : state.dglab.connected ? "生成配对码后用 DG-LAB APP 扫码" : "DG-LAB Socket V2 未连接"}</span>
              </div>
              <LanCandidateHint state={state} />
            </div>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelTitle icon={<Gauge size={18} />} title="通道实时强度" />
        <div className="channel-meters">
          <ChannelMeter
            channel="A"
            value={state.dglab.strengths?.A ?? 0}
            limit={state.safety.effectiveLimits?.A ?? state.safety.channelLimits.A}
            deviceLimit={state.dglab.strengths?.softLimitA}
          />
          <ChannelMeter
            channel="B"
            value={state.dglab.strengths?.B ?? 0}
            limit={state.safety.effectiveLimits?.B ?? state.safety.channelLimits.B}
            deviceLimit={state.dglab.strengths?.softLimitB}
          />
        </div>
        <SessionStatus state={state} />
      </Panel>

      <Panel>
        <PanelTitle icon={<Activity size={18} />} title="状态明细" />
        <div className="detail-grid">
          <StatusLine label="每分钟窗口" value={`${state.safety.recentEventsInWindow ?? 0}/${state.safety.maxEventsPerMinute}`} />
          <StatusLine label="DG-LAB Socket" value={state.dglab.socketUrl ?? "未启用"} />
          <StatusLine label="Client ID" value={state.dglab.clientId ?? "等待分配"} />
          <StatusLine label="Target ID" value={state.dglab.targetId ?? "等待 APP"} />
          <StatusLine label="配对码" value={state.dglab.qrLink ?? state.dglab.lastError ?? "等待生成"} />
        </div>
      </Panel>
    </div>
  );
}

function RuntimeToggle({
  checked,
  disabled,
  title,
  detail,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  title: string;
  detail: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="runtime-toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

/**
 * Multi-NIC machines (WSL, Docker, VPN) routinely produce a QR pointing at an
 * address the phone cannot reach, so show what was picked and the alternatives.
 */
function LanCandidateHint({ state }: { state: UiState }) {
  const candidates = state.lanCandidates ?? [];
  if (candidates.length === 0) {
    return null;
  }

  const chosenHost = state.dglab.qrLink ? extractHost(state.dglab.qrLink) : undefined;
  const alternatives = candidates.filter((candidate) => candidate.address !== chosenHost);

  return (
    <div className="lan-hint">
      <div className="lan-hint-head">
        <Wifi size={14} />
        <span>
          配对地址 <code>{chosenHost ?? candidates[0]?.address ?? "自动"}</code>
        </span>
      </div>
      {alternatives.length > 0 ? (
        <details>
          <summary>手机扫不上？换一个网卡地址</summary>
          <ul>
            {alternatives.map((candidate) => (
              <li key={`${candidate.interfaceName}-${candidate.address}`}>
                <code>{candidate.address}</code>
                <small>
                  {candidate.interfaceName}
                  {candidate.likelyVirtual ? " · 虚拟网卡" : ""}
                </small>
              </li>
            ))}
          </ul>
          <p>
            在 <code>config.yaml</code> 中把 <code>dglab.qr_host</code> 改成上面某个地址后重启即可。
          </p>
        </details>
      ) : null}
    </div>
  );
}

function extractHost(link: string): string | undefined {
  // The QR payload embeds a ws:// URL inside a longer app-download link.
  const match = /wss?:\/\/([^/:]+)/i.exec(link);
  return match?.[1];
}

function ChannelMeter({
  channel,
  value,
  limit,
  deviceLimit
}: {
  channel: Channel;
  value: number;
  limit: number;
  deviceLimit?: number;
}) {
  const capped = deviceLimit !== undefined && deviceLimit > 0 && deviceLimit < limit;
  return (
    <div className="channel-meter">
      <header>
        <strong>{channel} 通道</strong>
        <em>{value}</em>
      </header>
      <MeterBar value={value} max={100} limit={limit} tone={value > 0 ? "ok" : "neutral"} />
      <small>
        生效上限 {limit}
        {capped ? ` · 受 APP 软上限 ${deviceLimit} 限制` : ""}
      </small>
    </div>
  );
}

function SessionStatus({ state }: { state: UiState }) {
  if (!state.safety.armed) {
    return <InlineHint>反馈未启动时不会有任何真实输出。</InlineHint>;
  }

  const parts: string[] = [];
  if (state.safety.armedForMs !== undefined) {
    parts.push(`已运行 ${formatDuration(state.safety.armedForMs)}`);
  }
  if (state.safety.sessionRemainingMs !== undefined) {
    parts.push(`会话剩余 ${formatDuration(state.safety.sessionRemainingMs)}`);
  }
  if (state.safety.idleRemainingMs !== undefined) {
    parts.push(`闲置 ${formatDuration(state.safety.idleRemainingMs)} 后自动停止`);
  }

  return <InlineHint tone="ok">{parts.join(" · ") || "反馈进行中"}</InlineHint>;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

export function ProviderView({
  state,
  draft,
  dirty,
  setDirty,
  setDraft,
  runAction
}: {
  state: UiState;
  draft: ProviderDraft;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  setDraft: ProviderDraftSetter;
  runAction: RunAction;
}) {
  const patch = (updates: Partial<ProviderDraft>) => {
    setDirty(true);
    setDraft((current) => (current ? { ...current, ...updates } : current));
  };

  const applyPreset = (preset: string) => {
    const next = providerPresets[preset] ?? {};
    patch({
      ...next,
      id: next.id ? uniqueProviderId(next.id, state.upstream.providers) : draft.id
    });
  };

  const createProvider = () => {
    setDirty(true);
    setDraft({
      id: uniqueProviderId("custom", state.upstream.providers),
      name: "自定义供应商",
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "",
      timeoutMs: 120000
    });
  };

  const selectProvider = (id: string) => {
    const next = state.upstream.providers?.find((provider) => provider.id === id);
    if (!next) return;
    void runAction("provider", "供应商已切换", async () => {
      const result = await api<UiState>("/ui/upstream", {
        method: "POST",
        body: JSON.stringify({ action: "select", id })
      });
      setDirty(false);
      setDraft(providerFromSummary(next));
      return result;
    });
  };

  const savedProviders = state.upstream.providers ?? [];
  const draftIsSaved = savedProviders.some((provider) => provider.id === draft.id);

  return (
    <div className="page-stack">
      <PageTitle eyebrow="Provider" title="API 供应商">
        <StatusPill tone={dirty ? "warn" : state.upstream.hasApiKey ? "ok" : "neutral"}>{dirty ? "未保存" : state.upstream.hasApiKey ? "密钥已配置" : "等待密钥"}</StatusPill>
      </PageTitle>

      <Panel className="provider-panel">
        <PanelTitle icon={<Server size={18} />} title="供应商配置" />
        <div className="provider-toolbar">
          <Field label="当前供应商">
            <select value={draftIsSaved ? draft.id : "__draft"} onChange={(event) => selectProvider(event.target.value)} disabled={dirty}>
              {!draftIsSaved && <option value="__draft">{draft.name || "未保存供应商"}</option>}
              {savedProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="icon-button" type="button" onClick={createProvider} title="新建供应商" aria-label="新建供应商">
            <Plus size={18} />
          </button>
        </div>
        <div className="form-grid provider-form">
          <Field label="预设">
            <select value={matchingPreset(draft)} onChange={(event) => applyPreset(event.target.value)}>
              <option value="custom">自定义</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
          </Field>
          <Field label="名称">
            <input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
          </Field>
          <Field label="协议">
            <select value={draft.protocol} onChange={(event) => patch({ protocol: event.target.value as UpstreamProtocol })}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic Messages</option>
              <option value="gemini">Gemini GenerateContent</option>
            </select>
          </Field>
          <Field label="Base URL">
            <input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} />
          </Field>
          <Field label="API Key">
            <input type="password" value={draft.apiKey} placeholder={state.upstream.hasApiKey ? "已配置，留空不修改" : "保存在配置文件中"} onChange={(event) => patch({ apiKey: event.target.value })} />
          </Field>
          <Field label="超时 ms">
            <input type="number" min={1000} step={1000} value={draft.timeoutMs} onChange={(event) => patch({ timeoutMs: Number(event.target.value) })} />
          </Field>
        </div>
        <div className="panel-footer">
          <ActionButton
            disabled={!draftIsSaved || savedProviders.length <= 1}
            variant="secondary"
            icon={<Trash2 size={17} />}
            onClick={() =>
              runAction("provider", "供应商已删除", async () => {
                const next = await api<UiState>("/ui/upstream", {
                  method: "POST",
                  body: JSON.stringify({ action: "delete", id: draft.id })
                });
                setDirty(false);
                return next;
              })
            }
          >
            删除
          </ActionButton>
          <ActionButton
            disabled={!dirty}
            icon={<Save size={17} />}
            onClick={() =>
              runAction("provider", "供应商已保存", async () => {
                const payload: Record<string, unknown> = { ...draft };
                if (!draft.apiKey.trim()) delete payload.apiKey;
                const next = await api<UiState>("/ui/upstream", {
                  method: "POST",
                  body: JSON.stringify({ upstream: payload })
                });
                setDirty(false);
                return next;
              })
            }
          >
            保存供应商
          </ActionButton>
        </div>
      </Panel>
    </div>
  );
}

export function SafetyView({
  busy,
  draft,
  dirty,
  setDirty,
  setDraft,
  runAction
}: {
  busy: string | null;
  draft: SettingsDraft;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  setDraft: SettingsDraftSetter;
  runAction: RunAction;
}) {
  const update = (producer: (current: SettingsDraft) => SettingsDraft) => {
    setDirty(true);
    setDraft((current) => (current ? producer(current) : current));
  };

  return (
    <div className="page-stack">
      <PageTitle eyebrow="Safety" title="安全设置">
        <StatusPill tone={dirty ? "warn" : "ok"}>{dirty ? "未保存" : "已同步"}</StatusPill>
      </PageTitle>

      <Panel>
        <PanelTitle icon={<ShieldCheck size={18} />} title="硬上限" />
        <div className="safety-grid">
          <SafetyControl
            label="A 通道上限"
            value={draft.safety.channelLimits.A}
            min={0}
            max={100}
            unit="%"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, channelLimits: { ...current.safety.channelLimits, A: value } } }))}
          />
          <SafetyControl
            label="B 通道上限"
            value={draft.safety.channelLimits.B}
            min={0}
            max={100}
            unit="%"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, channelLimits: { ...current.safety.channelLimits, B: value } } }))}
          />
          <SafetyControl
            label="单次最长"
            value={draft.safety.maxContinuousOutputMs}
            min={100}
            max={30000}
            step={100}
            unit="ms"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, maxContinuousOutputMs: value } }))}
          />
          <SafetyControl
            label="每分钟上限"
            value={draft.safety.maxEventsPerMinute}
            min={1}
            max={600}
            unit="次"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, maxEventsPerMinute: value } }))}
          />
        </div>
        <InlineHint>通道上限还会与郊狼 APP 上报的软上限取更严格的一方。</InlineHint>
        <SettingsFooter busy={busy} dirty={dirty} draft={draft} setDirty={setDirty} setDraft={setDraft} runAction={runAction} />
      </Panel>

      <Panel>
        <PanelTitle icon={<Activity size={18} />} title="节奏与会话保护" />
        <div className="safety-grid">
          <SafetyControl
            label="单次最大增幅"
            value={Math.round(draft.safety.maxIntensityStep * 100)}
            min={1}
            max={100}
            unit="%"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, maxIntensityStep: value / 100 } }))}
          />
          <SafetyControl
            label="最小间隔"
            value={draft.safety.minIntervalMs}
            min={0}
            max={10000}
            step={10}
            unit="ms"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, minIntervalMs: value } }))}
          />
          <SafetyControl
            label="单次会话上限"
            value={Math.round(draft.safety.maxSessionMs / 60000)}
            min={0}
            max={360}
            unit="分钟"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, maxSessionMs: value * 60000 } }))}
          />
          <SafetyControl
            label="闲置自动停止"
            value={Math.round(draft.safety.idleDisarmMs / 60000)}
            min={0}
            max={60}
            unit="分钟"
            onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, idleDisarmMs: value * 60000 } }))}
          />
        </div>
        <InlineHint>
          增幅限制让强度逐级爬升，不会一步跳到上限；会话与闲置上限填 0 表示关闭。断开郊狼连接时也会自动停止反馈。
        </InlineHint>
        <SettingsFooter busy={busy} dirty={dirty} draft={draft} setDirty={setDirty} setDraft={setDraft} runAction={runAction} />
      </Panel>
    </div>
  );
}

function SafetyControl({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const update = (next: number) => onChange(clampNumber(next, min, max));
  return (
    <label className="safety-control">
      <span>
        <strong>{label}</strong>
        <em>
          {value}
          {unit}
        </em>
      </span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => update(Number(event.target.value))} />
    </label>
  );
}

export function FeedbackRulesView({
  state,
  busy,
  draft,
  dirty,
  setDirty,
  setDraft,
  runAction
}: {
  state: UiState;
  busy: string | null;
  draft: SettingsDraft;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  setDraft: SettingsDraftSetter;
  runAction: RunAction;
}) {
  const update = (producer: (current: SettingsDraft) => SettingsDraft) => {
    setDirty(true);
    setDraft((current) => (current ? producer(current) : current));
  };

  const updatePulse = (
    key: "requestStarted" | "responseStarted" | "responseToolCall" | "responseErrorStatus" | "responseDone",
    next: PulsePolicy
  ) =>
    update((current) => ({
      ...current,
      policy: {
        ...current.policy,
        [key]: next
      }
    }));

  const updateChunk = (next: ChunkPolicy) =>
    update((current) => ({
      ...current,
      policy: {
        ...current.policy,
        responseChunk: next
      }
    }));

  return (
    <div className="page-stack">
      <PageTitle eyebrow="Feedback" title="反馈规则">
        <StatusPill tone={dirty ? "warn" : "ok"}>{dirty ? "未保存" : "已同步"}</StatusPill>
        <StatusPill tone={state.waveforms.errors.length > 0 ? "warn" : "info"}>{state.waveforms.items.length} 个波形</StatusPill>
      </PageTitle>

      <Panel className="waveform-import-panel">
        <PanelTitle icon={<Activity size={18} />} title="波形导入" action={state.waveforms.directory}>
          <IconButton
            busy={busy === "waveforms-refresh"}
            icon={<RefreshCw size={18} />}
            title="刷新波形"
            onClick={() => runAction("waveforms-refresh", "波形目录已刷新", () => api<UiState>("/ui/waveforms/refresh", { method: "POST" }))}
          />
        </PanelTitle>
        <div className="waveform-summary">
          <StatusLine label="文件波形" value={`${state.waveforms.items.filter((item) => item.source === "file").length}`} />
          <StatusLine label="内置波形" value={`${state.waveforms.items.filter((item) => item.source === "builtin").length}`} />
          <StatusLine label="读取错误" value={`${state.waveforms.errors.length}`} />
        </div>
        {state.waveforms.errors.length > 0 ? (
          <ul className="waveform-errors">
            {state.waveforms.errors.map((error, index) => (
              <li key={index}>
                <strong>{error.fileName ?? error.directory ?? "波形目录"}</strong>
                <span>{error.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <WaveformLibrary state={state} busy={busy} runAction={runAction} />

      <div className="policy-grid">
        <PulseEditor title="请求开始" value={draft.policy.requestStarted} waveforms={state.waveforms} onChange={(next) => updatePulse("requestStarted", next)} />
        <PulseEditor title="响应开始" value={draft.policy.responseStarted} waveforms={state.waveforms} onChange={(next) => updatePulse("responseStarted", next)} />
        <ChunkEditor value={draft.policy.responseChunk} waveforms={state.waveforms} onChange={updateChunk} />
        <PulseEditor title="工具调用" value={draft.policy.responseToolCall} waveforms={state.waveforms} onChange={(next) => updatePulse("responseToolCall", next)} />
        <PulseEditor title="错误返回" value={draft.policy.responseErrorStatus} waveforms={state.waveforms} onChange={(next) => updatePulse("responseErrorStatus", next)} />
        <PulseEditor title="响应完成" value={draft.policy.responseDone} waveforms={state.waveforms} onChange={(next) => updatePulse("responseDone", next)} />
      </div>

      <Panel>
        <PanelTitle icon={<Save size={18} />} title="保存反馈规则" action={dirty ? "有未保存修改" : "无需保存"} />
        <SettingsFooter busy={busy} dirty={dirty} draft={draft} setDirty={setDirty} setDraft={setDraft} runAction={runAction} />
      </Panel>
    </div>
  );
}

/**
 * Lets the user see the shape of every available waveform and fire a single
 * pulse with it, so choosing a waveform is not guesswork from its filename.
 */
function WaveformLibrary({ state, busy, runAction }: { state: UiState; busy: string | null; runAction: RunAction }) {
  const canTest = state.dglab.enabled && state.dglab.connected && state.dglab.bound;

  return (
    <Panel>
      <PanelTitle icon={<Waves size={18} />} title="波形预览" action={canTest ? undefined : "试放需要先完成 APP 配对"} />
      {state.waveforms.items.length === 0 ? (
        <EmptyState>暂无可用波形</EmptyState>
      ) : (
        <div className="waveform-library">
          {state.waveforms.items.map((waveform) => (
            <article className="waveform-card" key={waveform.id}>
              <header>
                <div>
                  <strong>{waveform.name}</strong>
                  <small>
                    {waveform.source === "builtin" ? "内置" : waveform.fileName ?? "文件"} · {waveform.sampleCount} 样本 ·{" "}
                    {(waveform.durationMs / 1000).toFixed(1)}s
                  </small>
                </div>
                <ActionButton
                  variant="ghost"
                  busy={busy === `wave-test-${waveform.id}`}
                  disabled={!canTest}
                  icon={<Play size={15} />}
                  onClick={() =>
                    runAction(`wave-test-${waveform.id}`, `已用「${waveform.name}」试放`, () =>
                      api<UiState>("/ui/test-shock", {
                        method: "POST",
                        body: JSON.stringify({ waveformId: waveform.id, intensity: 0.1, durationMs: 400 })
                      })
                    )
                  }
                >
                  试放
                </ActionButton>
              </header>
              <WaveformChart amplitude={waveform.preview?.amplitude ?? []} label={undefined} />
            </article>
          ))}
        </div>
      )}
      <InlineHint tone="warn">试放同样会经过安全限制，强度固定为最低档。</InlineHint>
    </Panel>
  );
}

function SettingsFooter({
  busy,
  dirty,
  draft,
  setDirty,
  setDraft,
  runAction
}: {
  busy: string | null;
  dirty: boolean;
  draft: SettingsDraft;
  setDirty: (value: boolean) => void;
  setDraft: SettingsDraftSetter;
  runAction: RunAction;
}) {
  return (
    <div className="panel-footer">
      <ActionButton
        busy={busy === "settings-reset"}
        variant="secondary"
        icon={<RotateCcw size={17} />}
        onClick={() =>
          runAction("settings-reset", "已恢复默认参数", async () => {
            const next = await api<UiState>("/ui/settings", {
              method: "POST",
              body: JSON.stringify({ action: "reset-defaults" })
            });
            setDirty(false);
            setDraft(settingsFromState(next));
            return next;
          })
        }
      >
        重置默认
      </ActionButton>
      <ActionButton
        busy={busy === "settings"}
        disabled={!dirty}
        icon={<Save size={17} />}
        onClick={() =>
          runAction("settings", "参数已保存", async () => {
            const payload = { safety: draft.safety, policy: draft.policy };
            const next = await api<UiState>("/ui/settings", {
              method: "POST",
              body: JSON.stringify(payload)
            });
            setDirty(false);
            return next;
          })
        }
      >
        保存参数
      </ActionButton>
    </div>
  );
}

function PulseEditor({
  title,
  value,
  waveforms,
  onChange
}: {
  title: string;
  value: PulsePolicy;
  waveforms: WaveformState;
  onChange: (value: PulsePolicy) => void;
}) {
  return (
    <Panel className="pulse-card">
      <PanelTitle icon={<Zap size={18} />} title={title} />
      <div className="compact-fields pulse-fields">
        <ChannelSelect value={value.channel} onChange={(channel) => onChange({ ...value, channel })} />
        <CoefficientField value={value.coefficient} onChange={(coefficient) => onChange({ ...value, coefficient })} />
        <NumberField label="持续 ms" value={value.durationMs} min={1} max={30000} step={10} onChange={(durationMs) => onChange({ ...value, durationMs })} />
        {value.tokenTarget !== undefined ? (
          <NumberField
            label="满强度 token"
            value={value.tokenTarget}
            min={1}
            max={100000}
            step={50}
            onChange={(tokenTarget) => onChange({ ...value, tokenTarget })}
          />
        ) : null}
        <WaveformSelect value={value.waveformId ?? ""} waveforms={waveforms} onChange={(waveformId) => onChange({ ...value, waveformId })} />
      </div>
    </Panel>
  );
}

function ChunkEditor({ value, waveforms, onChange }: { value: ChunkPolicy; waveforms: WaveformState; onChange: (value: ChunkPolicy) => void }) {
  return (
    <Panel className="pulse-card stream-card">
      <PanelTitle icon={<Activity size={18} />} title="流式输出" />
      <div className="compact-fields stream-fields">
        <ChannelSelect value={value.channel} onChange={(channel) => onChange({ ...value, channel })} />
        <CoefficientField value={value.coefficient} onChange={(coefficient) => onChange({ ...value, coefficient })} />
        <MicroIntensityField value={value.microIntensity} onChange={(microIntensity) => onChange({ ...value, microIntensity })} />
        <NumberField label="持续 ms" value={value.durationMs} min={1} max={30000} step={10} onChange={(durationMs) => onChange({ ...value, durationMs })} />
        <WaveformSelect value={value.waveformId ?? ""} waveforms={waveforms} onChange={(waveformId) => onChange({ ...value, waveformId })} />
      </div>
    </Panel>
  );
}

function WaveformSelect({
  value,
  waveforms,
  onChange
}: {
  value: string;
  waveforms: WaveformState;
  onChange: (value: string | null) => void;
}) {
  const hasMissingSelection = Boolean(value) && !waveforms.items.some((waveform) => waveform.id === value);

  return (
    <Field label="波形">
      <select value={value} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">默认波形</option>
        {hasMissingSelection ? <option value={value}>未找到: {value}</option> : null}
        {waveforms.items.map((waveform) => (
          <option key={waveform.id} value={waveform.id}>
            {waveform.source === "builtin" ? "内置" : "文件"} · {waveform.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

const MAX_COEFFICIENT = 2;

function CoefficientField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const update = (next: number) => onChange(clampNumber(next, 0, MAX_COEFFICIENT));
  const bubbleStyle = { "--value": `${(value / MAX_COEFFICIENT) * 100}%` } as React.CSSProperties;

  return (
    <Field label="强度系数">
      <div className={`coefficient-control ${value > 1 ? "boosted" : ""}`.trim()} style={bubbleStyle}>
        <span className="coefficient-value">{value.toFixed(2).replace(/\.?0+$/, "")}</span>
        <input
          className="coefficient-slider"
          type="range"
          min={0}
          max={MAX_COEFFICIENT}
          step={0.05}
          value={value}
          aria-label="强度系数滑块"
          onChange={(event) => update(Number(event.target.value))}
        />
      </div>
    </Field>
  );
}

function MicroIntensityField({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <Field label="微电流强度">
      <input type="number" min={0} max={1} step={0.1} value={value} onChange={(event) => onChange(clampNumber(Number(event.target.value), 0, 1))} />
    </Field>
  );
}

function ChannelSelect({ value, onChange }: { value: Channel; onChange: (value: Channel) => void }) {
  return (
    <Field label="通道">
      <div className="channel-toggle" role="group" aria-label="通道">
        {(["A", "B"] as Channel[]).map((channel) => (
          <button className={value === channel ? "active" : ""} key={channel} type="button" onClick={() => onChange(channel)}>
            {channel}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function LogsView({ state }: { state: UiState }) {
  return (
    <div className="page-stack">
      <PageTitle eyebrow="日志" title="日志记录" />
      <div className="log-grid">
        <EventsPanel state={state} />
        <PlansPanel plans={state.shockPlans ?? []} />
      </div>
    </div>
  );
}

export function EventsPanel({ state }: { state: UiState }) {
  const events = newestFirst(state.events);
  return (
    <Panel>
      <PanelTitle icon={<Activity size={18} />} title="最近事件" action={`${events.length}`} />
      <div className="log-list">
        {events.length === 0 ? (
          <EmptyState>暂无事件</EmptyState>
        ) : (
          events.map((event, index) => (
            <div className="log-row" key={`${event.timestamp}-${event.type}-${index}`}>
              <strong>{eventTypeLabel(event.type)}</strong>
              <span>{eventDetail(event)}</span>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

export function PlansPanel({ plans }: { plans: ShockPlanRecord[] }) {
  const items = newestFirst(plans);
  return (
    <Panel>
      <PanelTitle icon={<Zap size={18} />} title="最近计划" action={`${items.length}`} />
      <div className="log-list">
        {items.length === 0 ? (
          <EmptyState>暂无计划</EmptyState>
        ) : (
          items.map((plan, index) => (
            <div className={`log-row plan ${plan.outcome}`} key={`${plan.timestamp}-${plan.eventType}-${index}`}>
              <strong>{eventTypeLabel(plan.eventType)}</strong>
              <span>{planDetail(plan)}</span>
              <time>{new Date(plan.timestamp).toLocaleTimeString()}</time>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
