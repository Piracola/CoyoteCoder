import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Info,
  Link2,
  Loader2,
  Plus,
  Play,
  PlugZap,
  Power,
  QrCode,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Unplug,
  Zap
} from "lucide-react";
import {
  API_BASE,
  api,
  apiUrl,
  providerFromState,
  providerFromSummary,
  settingsFromState,
  type Channel,
  type ChunkPolicy,
  type ProviderDraft,
  type PulsePolicy,
  type SettingsDraft,
  type ShockPlanRecord,
  type UiState,
  type UpstreamProtocol
} from "./api";
import "./styles.css";

const providerPresets: Record<string, Partial<ProviderDraft>> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com"
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com"
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta"
  }
};

function App() {
  const [state, setState] = useState<UiState | null>(null);
  const [provider, setProvider] = useState<ProviderDraft | null>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [providerDirty, setProviderDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [qrVersion, setQrVersion] = useState(0);

  const showToast = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  const refresh = useCallback(
    async (quiet = false) => {
      try {
        const next = await api<UiState>("/ui/state");
        setState(next);
        if (!providerDirty) setProvider(providerFromState(next));
        if (!settingsDirty) setSettings(settingsFromState(next));
      } catch (error) {
        if (!quiet) showToast(error instanceof Error ? error.message : String(error), "error");
      } finally {
        setLoading(false);
      }
    },
    [providerDirty, settingsDirty, showToast]
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 3000);
    const onFocus = () => void refresh(true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (key: string, success: string, action: () => Promise<UiState | void>) => {
      setBusy(key);
      try {
        const result = await action();
        if (result) {
          setState(result);
          if (!providerDirty) setProvider(providerFromState(result));
          if (!settingsDirty) setSettings(settingsFromState(result));
        } else {
          await refresh(true);
        }
        showToast(success);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), "error");
      } finally {
        setBusy(null);
      }
    },
    [providerDirty, refresh, settingsDirty, showToast]
  );

  const metrics = useMemo(() => {
    const events = state?.events ?? [];
    const plans = state?.shockPlans ?? [];
    return {
      events: events.length,
      plans: plans.length,
      sent: plans.filter((plan) => plan.outcome === "sent").length,
      blocked: plans.filter((plan) => plan.outcome === "blocked" || plan.outcome === "error").length
    };
  }, [state]);

  if (loading && !state) {
    return (
      <main className="boot">
        <Loader2 className="spin" size={28} />
        <span>正在连接 CoyoteCoder 后端</span>
      </main>
    );
  }

  return (
    <>
      <header className="shell-header">
        <div className="brand">
          <span className="brand-mark">
            <Zap size={22} />
          </span>
          <div>
            <h1>CoyoteCoder</h1>
            <p>{state ? providerLabel(state) : "本地控制台"}</p>
          </div>
        </div>
        <div className="header-actions">
          <StatusPill tone={state?.safety.dryRun ? "warn" : "danger"}>{state?.safety.dryRun ? "预览模式" : "设备输出"}</StatusPill>
          <StatusPill tone={state?.safety.armed ? "ok" : "neutral"}>{state?.safety.armed ? "反馈已启动" : "反馈已停止"}</StatusPill>
          <StatusPill tone={state?.dglab.bound ? "ok" : state?.dglab.connected ? "warn" : "neutral"}>
            {state?.dglab.bound ? "DG-LAB 已配对" : state?.dglab.connected ? "DG-LAB 已连接" : "DG-LAB 未连接"}
          </StatusPill>
          <button className="icon-button" type="button" onClick={() => refresh()} title="刷新状态" aria-label="刷新状态">
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <main className="workspace">
        <ApiNotice />
        {state && (
          <>
            <section className="workspace-group">
              <SectionHeader title="运行与设备">
                <SummaryMetric icon={<Activity size={16} />} label="事件" value={metrics.events} />
                <SummaryMetric icon={<Zap size={16} />} label="计划" value={metrics.plans} />
                <SummaryMetric icon={<CheckCircle2 size={16} />} label="已发送" value={metrics.sent} />
                <SummaryMetric icon={<AlertTriangle size={16} />} label="拦截/错误" value={metrics.blocked} tone="danger" />
              </SectionHeader>
              <section className="grid operation-grid">
                <RuntimePanel state={state} busy={busy} runAction={runAction} />
                <QrPanel state={state} busy={busy} qrVersion={qrVersion} setQrVersion={setQrVersion} runAction={runAction} />
              </section>
            </section>

            <section className="workspace-group">
              <SectionHeader title="配置与参数" />
              <section className="grid config-grid">
                {provider && (
                  <ProviderPanel
                    state={state}
                    draft={provider}
                    dirty={providerDirty}
                    setDirty={setProviderDirty}
                    setDraft={setProvider}
                    runAction={runAction}
                  />
                )}
                {settings && (
                  <SettingsPanel
                    draft={settings}
                    dirty={settingsDirty}
                    setDirty={setSettingsDirty}
                    setDraft={setSettings}
                    runAction={runAction}
                  />
                )}
              </section>
            </section>

            <section className="workspace-group">
              <SectionHeader title="记录" />
              <section className="grid log-grid">
                <EventsPanel state={state} />
                <PlansPanel plans={state.shockPlans ?? []} />
              </section>
            </section>
          </>
        )}
      </main>

      <div className={`toast ${toast ? "show" : ""} ${toast?.tone ?? "ok"}`} role="status" aria-live="polite">
        {toast?.message}
      </div>
    </>
  );
}

function ApiNotice() {
  return (
    <section className="api-notice" aria-label="下游 API 提示">
      <Info size={17} />
      <div>
        <strong>下游客户端 API 地址</strong>
        <span>
          Base URL 填 <code>{downstreamApiUrl()}</code>，API Key 默认留空，不需要设置。
        </span>
      </div>
    </section>
  );
}

function RuntimePanel({
  state,
  busy,
  runAction
}: {
  state: UiState;
  busy: string | null;
  runAction: (key: string, success: string, action: () => Promise<UiState | void>) => Promise<void>;
}) {
  return (
    <section className="panel runtime-panel">
      <PanelTitle icon={<Power size={18} />} title="运行控制" />
      <div className="command-row">
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
        <ActionButton
          busy={busy === "panic"}
          variant="danger"
          icon={<AlertTriangle size={17} />}
          onClick={() =>
            runAction("panic", "已执行紧急停止", async () => {
              await api("/control/panic", { method: "POST" });
              return api<UiState>("/ui/state");
            })
          }
        >
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
                body: JSON.stringify({ channel: "A", intensity: 0.05, durationMs: 220 })
              })
            )
          }
        >
          测试电击
        </ActionButton>
      </div>
      <div className="runtime-status">
        <StatusLine label="安全状态" value={state.safety.panic ? "Panic 锁定" : state.safety.armed ? "允许计划输出" : "等待启动"} />
        <StatusLine label="配对状态" value={dglabLinkLabel(state)} />
        <StatusLine label="每分钟窗口" value={`${state.safety.recentEventsInWindow ?? 0}/${state.safety.maxEventsPerMinute}`} />
        <StatusLine label="DG-LAB Socket" value={state.dglab.socketUrl ?? "未启用"} />
        <StatusLine label="Client ID" value={state.dglab.clientId ?? "等待分配"} />
        <StatusLine label="Target ID" value={state.dglab.targetId ?? "等待 APP"} />
        <StatusLine label="当前强度" value={`A ${state.dglab.strengths?.A ?? 0} / B ${state.dglab.strengths?.B ?? 0}`} />
      </div>
      <label className="runtime-toggle">
        <input
          type="checkbox"
          checked={state.safety.dryRun}
          disabled={busy === "preview-mode"}
          onChange={(event) =>
            runAction("preview-mode", event.target.checked ? "预览模式已开启" : "设备输出已开启", () =>
              api<UiState>("/ui/settings", {
                method: "POST",
                body: JSON.stringify({ dryRun: event.target.checked })
              })
            )
          }
        />
        <span>
          <strong>预览模式</strong>
          <small>只记录计划，不发送真实设备输出</small>
        </span>
      </label>
    </section>
  );
}

function QrPanel({
  state,
  busy,
  qrVersion,
  setQrVersion,
  runAction
}: {
  state: UiState;
  busy: string | null;
  qrVersion: number;
  setQrVersion: (value: number | ((next: number) => number)) => void;
  runAction: (key: string, success: string, action: () => Promise<UiState | void>) => Promise<void>;
}) {
  const qrSrc = state.dglab.qrLink ? apiUrl(`/ui/qr.svg?t=${qrVersion}`) : "";
  return (
    <section className="panel qr-panel">
      <PanelTitle icon={<QrCode size={18} />} title="设备配对" />
      <div className="qr-content">
        <div className="qr-box">
          {qrSrc ? <img src={qrSrc} alt="DG-LAB 配对二维码" /> : <QrCode size={54} strokeWidth={1.5} />}
        </div>
        <div className="qr-actions">
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
      </div>
      <div className={`link-state ${state.dglab.bound ? "ok" : state.dglab.connected ? "warn" : "neutral"}`}>
        <strong>{dglabLinkLabel(state)}</strong>
        <span>{state.dglab.bound ? "已绑定 · 预览/受控测试可用" : state.dglab.connected ? "Socket 已连接 · 等待扫码" : "等待连接 DG-LAB Socket V2"}</span>
      </div>
      <p className="mono">{state.dglab.qrLink ?? state.dglab.lastError ?? "等待生成 clientId"}</p>
    </section>
  );
}

function ProviderPanel({
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
  setDraft: (value: ProviderDraft | ((next: ProviderDraft | null) => ProviderDraft | null)) => void;
  runAction: (key: string, success: string, action: () => Promise<UiState | void>) => Promise<void>;
}) {
  const patch = (updates: Partial<ProviderDraft>) => {
    setDirty(true);
    setDraft((current) => (current ? { ...current, ...updates } : current));
  };

  const applyPreset = (preset: string) => {
    const next = providerPresets[preset] ?? {};
    patch({
      ...next,
      id: next.id ? uniqueProviderId(next.id, state.upstream.providers ?? []) : draft.id
    });
  };

  const createProvider = () => {
    setDirty(true);
    setDraft({
      id: uniqueProviderId("custom", state.upstream.providers ?? []),
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
    <section className="panel provider-panel">
      <PanelTitle icon={<Server size={18} />} title="API 供应商" action={dirty ? "未保存" : state.upstream.hasApiKey ? "密钥已配置" : "等待密钥"} />
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
          <input
            type="password"
            value={draft.apiKey}
            placeholder={state.upstream.hasApiKey ? "已配置，留空不修改" : "保存在配置文件中"}
            onChange={(event) => patch({ apiKey: event.target.value })}
          />
        </Field>
        <Field label="超时 ms">
          <input type="number" min={1000} step={1000} value={draft.timeoutMs} onChange={(event) => patch({ timeoutMs: Number(event.target.value) })} />
        </Field>
      </div>
      <div className="panel-footer">
        <ActionButton
          disabled={!draftIsSaved || savedProviders.length <= 1}
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
    </section>
  );
}

function SettingsPanel({
  draft,
  dirty,
  setDirty,
  setDraft,
  runAction
}: {
  draft: SettingsDraft;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  setDraft: (value: SettingsDraft | ((next: SettingsDraft | null) => SettingsDraft | null)) => void;
  runAction: (key: string, success: string, action: () => Promise<UiState | void>) => Promise<void>;
}) {
  const update = (producer: (current: SettingsDraft) => SettingsDraft) => {
    setDirty(true);
    setDraft((current) => (current ? producer(current) : current));
  };

  const updatePulse = (key: "requestStarted" | "responseStarted" | "responseDone", next: PulsePolicy) =>
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
    <section className="panel settings-panel">
      <PanelTitle icon={<SlidersHorizontal size={18} />} title="安全与反馈参数" action={dirty ? "未保存" : "已同步"} />
      <div className="settings-layout">
        <section className="field-group">
          <h3>
            <ShieldCheck size={16} /> 安全限制
          </h3>
          <div className="inline-fields">
            <NumberField label="A 通道上限" value={draft.safety.channelLimits.A} min={0} max={100} onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, channelLimits: { ...current.safety.channelLimits, A: value } } }))} />
            <NumberField label="B 通道上限" value={draft.safety.channelLimits.B} min={0} max={100} onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, channelLimits: { ...current.safety.channelLimits, B: value } } }))} />
            <NumberField label="最小间隔 ms" value={draft.safety.minEventIntervalMs} min={0} max={10000} step={10} onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, minEventIntervalMs: value } }))} />
            <NumberField label="单次最长 ms" value={draft.safety.maxContinuousOutputMs} min={1} max={30000} step={100} onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, maxContinuousOutputMs: value } }))} />
            <NumberField label="每分钟上限" value={draft.safety.maxEventsPerMinute} min={1} max={600} onChange={(value) => update((current) => ({ ...current, safety: { ...current.safety, maxEventsPerMinute: value } }))} />
          </div>
        </section>

        <PulseEditor title="请求开始" value={draft.policy.requestStarted} onChange={(next) => updatePulse("requestStarted", next)} />
        <PulseEditor title="响应开始" value={draft.policy.responseStarted} onChange={(next) => updatePulse("responseStarted", next)} />
        <ChunkEditor value={draft.policy.responseChunk} onChange={updateChunk} />
        <PulseEditor title="响应完成" value={draft.policy.responseDone} onChange={(next) => updatePulse("responseDone", next)} />
      </div>
      <div className="panel-footer">
        <ActionButton
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
    </section>
  );
}

function EventsPanel({ state }: { state: UiState }) {
  const events = [...(state.events ?? [])].reverse();
  return (
    <section className="panel">
      <PanelTitle icon={<Activity size={18} />} title="最近事件" action={`${events.length}`} />
      <div className="log-list">
        {events.length === 0 ? (
          <p className="empty">暂无事件</p>
        ) : (
          events.map((event, index) => (
            <div className="log-row" key={`${event.timestamp}-${event.type}-${index}`}>
              <strong>{event.type}</strong>
              <span>{eventDetail(event)}</span>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function PlansPanel({ plans }: { plans: ShockPlanRecord[] }) {
  const items = [...plans].reverse();
  return (
    <section className="panel">
      <PanelTitle icon={<Zap size={18} />} title="最近计划" action={`${items.length}`} />
      <div className="log-list">
        {items.length === 0 ? (
          <p className="empty">暂无计划</p>
        ) : (
          items.map((plan, index) => (
            <div className={`log-row plan ${plan.outcome}`} key={`${plan.timestamp}-${plan.eventType}-${index}`}>
              <strong>{plan.eventType}</strong>
              <span>{planDetail(plan)}</span>
              <time>{new Date(plan.timestamp).toLocaleTimeString()}</time>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function PulseEditor({ title, value, onChange }: { title: string; value: PulsePolicy; onChange: (value: PulsePolicy) => void }) {
  return (
    <section className="field-group">
      <h3>
        <Zap size={16} /> {title}
      </h3>
      <div className="compact-fields">
        <ChannelSelect value={value.channel} onChange={(channel) => onChange({ ...value, channel })} />
        <IntensityField value={Math.round(value.intensity * 100)} onChange={(next) => onChange({ ...value, intensity: next / 100 })} />
        <NumberField label="持续 ms" value={value.durationMs} min={1} max={30000} step={10} onChange={(durationMs) => onChange({ ...value, durationMs })} />
      </div>
    </section>
  );
}

function ChunkEditor({ value, onChange }: { value: ChunkPolicy; onChange: (value: ChunkPolicy) => void }) {
  return (
    <section className="field-group">
      <h3>
        <Activity size={16} /> 流式输出
      </h3>
      <div className="compact-fields">
        <ChannelSelect value={value.channel} onChange={(channel) => onChange({ ...value, channel })} />
        <IntensityField label="最小强度 %" value={Math.round(value.minIntensity * 100)} onChange={(next) => onChange({ ...value, minIntensity: next / 100 })} />
        <IntensityField label="最大强度 %" value={Math.round(value.maxIntensity * 100)} onChange={(next) => onChange({ ...value, maxIntensity: next / 100 })} />
        <NumberField label="持续 ms" value={value.durationMs} min={1} max={30000} step={10} onChange={(durationMs) => onChange({ ...value, durationMs })} />
        <NumberField label="速率窗口 ms" value={value.rateWindowMs} min={1} max={10000} step={50} onChange={(rateWindowMs) => onChange({ ...value, rateWindowMs })} />
      </div>
    </section>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

function IntensityField({ label = "强度 %", value, onChange }: { label?: string; value: number; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      <div className="range-field">
        <input type="range" min={0} max={100} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <input type="number" min={0} max={100} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      </div>
    </Field>
  );
}

function ChannelSelect({ value, onChange }: { value: Channel; onChange: (value: Channel) => void }) {
  return (
    <Field label="通道">
      <select value={value} onChange={(event) => onChange(event.target.value as Channel)}>
        <option value="A">A</option>
        <option value="B">B</option>
      </select>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function PanelTitle({ icon, title, action }: { icon: React.ReactNode; title: string; action?: string }) {
  return (
    <div className="panel-title">
      <h2>
        {icon}
        {title}
      </h2>
      {action ? <span>{action}</span> : null}
    </div>
  );
}

function ActionButton({
  children,
  icon,
  busy,
  disabled,
  variant = "primary",
  onClick
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  onClick: () => void;
}) {
  return (
    <button className={`button ${variant}`} type="button" disabled={disabled || busy} onClick={onClick}>
      {busy ? <Loader2 className="spin" size={17} /> : icon}
      <span>{children}</span>
    </button>
  );
}

function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {children ? <div className="summary-strip">{children}</div> : null}
    </div>
  );
}

function SummaryMetric({ icon, label, value, tone = "normal" }: { icon: React.ReactNode; label: string; value: number; tone?: "normal" | "danger" }) {
  return (
    <span className={`summary-metric ${tone}`}>
      {icon}
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone: "ok" | "warn" | "danger" | "neutral" }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function providerLabel(state: UiState): string {
  const upstream = state.upstream;
  return `上游: ${upstream.name ?? "未配置"} · ${upstream.protocol ?? "openai"} · ${upstream.baseUrl ?? ""}`;
}

function downstreamApiUrl(): string {
  if (API_BASE.startsWith("http")) {
    return `${API_BASE.replace(/\/$/, "")}/v1`;
  }
  return new URL("/v1", window.location.href).toString().replace(/\/$/, "");
}

function dglabLinkLabel(state: UiState): string {
  if (!state.dglab.enabled) return "DG-LAB 未启用";
  if (state.dglab.bound) return "APP 已配对";
  if (state.dglab.connected) return "Socket 已连接";
  return "未连接";
}

function matchingPreset(provider: ProviderDraft): string {
  if (provider.protocol === "openai" && provider.baseUrl === "https://api.openai.com") return "openai";
  if (provider.protocol === "anthropic" && provider.baseUrl === "https://api.anthropic.com") return "anthropic";
  if (provider.protocol === "gemini" && provider.baseUrl === "https://generativelanguage.googleapis.com/v1beta") return "gemini";
  return "custom";
}

function uniqueProviderId(seed: string, providers: UiState["upstream"]["providers"]): string {
  const base = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "custom";
  const ids = new Set((providers ?? []).map((provider) => provider.id));
  if (!ids.has(base)) return base;
  let index = 2;
  while (ids.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function eventDetail(event: UiState["events"][number]): string {
  if (event.model) return event.model;
  if (event.chars !== undefined) return `${event.chars} chars`;
  if (event.bytes !== undefined) return `${event.bytes} bytes`;
  if (event.message) return event.message;
  if (event.endpoint) return event.endpoint;
  return event.requestId ?? "";
}

function planDetail(record: ShockPlanRecord): string {
  const plan = record.output ?? record.input ?? {};
  const channel = plan.channel ? `${plan.channel} 通道` : "无通道";
  const intensity = `${Math.round(Number(plan.intensity ?? 0) * 100)}%`;
  const duration = `${plan.durationMs ?? 0}ms`;
  const suffix = record.error ? ` · ${record.error}` : "";
  return `${record.outcome} · ${channel} · ${intensity} · ${duration}${suffix}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
