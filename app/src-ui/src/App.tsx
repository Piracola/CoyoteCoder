import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  LayoutDashboard,
  Loader2,
  Power,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import {
  api,
  getRunInBackground,
  providerFromState,
  settingsFromState,
  type ProviderDraft,
  type SettingsDraft,
  type UiState
} from "./api";
import appIconUrl from "./assets/icon.png";
import { ActionButton, IconButton, StatusPill, Toast } from "./components";
import { dglabLinkLabel, downstreamApiUrl, outputModeLabel, providerLabel } from "./helpers";
import {
  FeedbackRulesView,
  LogsView,
  OverviewView,
  ProviderView,
  RuntimeView,
  SafetyView,
  type RunAction,
  type ViewId
} from "./views";

const navItems: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "总览", icon: <LayoutDashboard size={18} /> },
  { id: "runtime", label: "运行与配对", icon: <Power size={18} /> },
  { id: "provider", label: "API 供应商", icon: <Server size={18} /> },
  { id: "feedback", label: "反馈规则", icon: <SlidersHorizontal size={18} /> },
  { id: "safety", label: "安全设置", icon: <ShieldCheck size={18} /> },
  { id: "logs", label: "日志记录", icon: <ScrollText size={18} /> }
];

const PROJECT_HOME_URL = "https://github.com/Piracola/CoyoteCoder";

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [state, setState] = useState<UiState | null>(null);
  const [provider, setProvider] = useState<ProviderDraft | null>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null);
  const [providerDirty, setProviderDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [qrVersion, setQrVersion] = useState(0);
  const [runInBackground, setRunInBackgroundState] = useState(false);

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

  useEffect(() => {
    void getRunInBackground()
      .then(setRunInBackgroundState)
      .catch((error) => showToast(error instanceof Error ? error.message : String(error), "error"));
  }, [showToast]);

  const runAction: RunAction = useCallback(
    async (key, success, action) => {
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

  const panic = useCallback(() => {
    void runAction("panic", "已执行紧急停止", async () => {
      await api("/control/panic", { method: "POST" });
      return api<UiState>("/ui/state");
    });
  }, [runAction]);

  const activeTitle = useMemo(() => navItems.find((item) => item.id === activeView)?.label ?? "总览", [activeView]);

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
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">
              <img src={appIconUrl} alt="" />
            </span>
            <div>
              <h1>CoyoteCoder</h1>
              <p>Portable Console</p>
            </div>
          </div>

          <nav className="nav-list" aria-label="主导航">
            {navItems.map((item) => (
              <button className={activeView === item.id ? "active" : ""} key={item.id} type="button" onClick={() => setActiveView(item.id)}>
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <a className="github-link" href={PROJECT_HOME_URL} target="_blank" rel="noreferrer" title="打开 GitHub 项目主页" aria-label="打开 GitHub 项目主页">
              <GithubLogo />
            </a>
          </div>
        </aside>

        <div className="main-shell">
          <header className="topbar">
            <div className="topbar-title">
              <span>{activeTitle}</span>
              <strong>{state ? providerLabel(state) : "本地控制台"}</strong>
              {activeView === "overview" && state ? (
                <small>
                  下游客户端 API 地址 Base URL 填 <code>{downstreamApiUrl()}</code>，API Key 默认留空。
                </small>
              ) : null}
            </div>
            <div className="topbar-actions">
              {state ? (
                <>
                  <StatusPill tone={state.safety.dryRun ? "warn" : "danger"}>{outputModeLabel(state)}</StatusPill>
                  <StatusPill tone={state.safety.armed ? "ok" : "neutral"}>{state.safety.armed ? "反馈已启动" : "反馈已停止"}</StatusPill>
                  <StatusPill tone={state.dglab.bound ? "ok" : state.dglab.connected ? "warn" : "neutral"}>{dglabLinkLabel(state)}</StatusPill>
                </>
              ) : null}
              <IconButton icon={<RefreshCw size={18} />} title="刷新状态" onClick={() => void refresh()} />
              <ActionButton className="panic-global" busy={busy === "panic"} disabled={!state} variant="danger" icon={<AlertTriangle size={17} />} onClick={panic}>
                紧急停止
              </ActionButton>
            </div>
          </header>

          <main className="content">{state ? renderView() : <EmptyBackend />}</main>
        </div>
      </div>

      <Toast toast={toast} />
    </>
  );

  function renderView() {
    if (!state) return null;

    if (activeView === "overview") {
      return <OverviewView state={state} busy={busy} runAction={runAction} onNavigate={setActiveView} onPanic={panic} />;
    }

    if (activeView === "runtime") {
      return (
        <RuntimeView
          state={state}
          busy={busy}
          qrVersion={qrVersion}
          setQrVersion={setQrVersion}
          runInBackground={runInBackground}
          setRunInBackgroundState={setRunInBackgroundState}
          showToast={showToast}
          runAction={runAction}
          onPanic={panic}
        />
      );
    }

    if (activeView === "provider" && provider) {
      return <ProviderView state={state} draft={provider} dirty={providerDirty} setDirty={setProviderDirty} setDraft={setProvider} runAction={runAction} />;
    }

    if (activeView === "feedback" && settings) {
      return <FeedbackRulesView state={state} busy={busy} draft={settings} dirty={settingsDirty} setDirty={setSettingsDirty} setDraft={setSettings} runAction={runAction} />;
    }

    if (activeView === "safety" && settings) {
      return <SafetyView busy={busy} draft={settings} dirty={settingsDirty} setDirty={setSettingsDirty} setDraft={setSettings} runAction={runAction} />;
    }

    if (activeView === "logs") {
      return <LogsView state={state} />;
    }

    return <EmptyBackend />;
  }
}

function EmptyBackend() {
  return (
    <main className="boot inline">
      <Loader2 className="spin" size={24} />
      <span>正在读取状态</span>
    </main>
  );
}

function GithubLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22">
      <path
        fill="currentColor"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.11.78-.25.78-.55 0-.27-.01-.99-.02-1.94-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18.92-.26 1.9-.38 2.88-.39.98.01 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.75.11 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.42.36.78 1.08.78 2.18 0 1.57-.01 2.84-.01 3.23 0 .31.21.67.79.55A10.99 10.99 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
      />
    </svg>
  );
}
