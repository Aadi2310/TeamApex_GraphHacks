"use client";

import { useCallback, useEffect, useState } from "react";
import { MemoryGraph } from "../components/ui/memory-graph";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const headers = { "Content-Type": "application/json", "X-User-ID": "demo-user" };

type Mem = {
  id: string;
  type: string;
  kind?: string;
  content: string;
  title?: string;
  status?: string;
  confidence?: number;
  source?: string;
  path?: string[];
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  memories?: Mem[];
  explanation?: string;
};

type Node = {
  id: string;
  type: string;
  title?: string;
  content?: string;
  status?: string;
};

type GoalGroup = {
  goal: Node;
  tasks: Node[];
};

type Activity = {
  id?: string;
  name: string;
  status: string;
  operation: string;
  created_at?: string;
  memories_affected?: string[];
  detail?: string;
};

const SUGGESTIONS = [
  { label: "⚡ What should I work on next?", text: "What should I work on next for my hackathon project?" },
  { label: "🎯 Finish MVP by Sunday", text: "I'm building GraphMind OS for a hackathon. My goal is to finish the MVP by Sunday. I have completed the chat interface, but the graph retrieval is still pending." },
  { label: "🧠 Show active goals & tasks", text: "List my active goals and pending tasks." },
  { label: "✧ Check conflicts & reflect", text: "Are there any conflicting memories or tasks I should be aware of?" },
];

export default function Home() {
  const [page, setPage] = useState("Chat");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sid, setSid] = useState<string>();
  const [sessions, setSessions] = useState<any[]>([]);
  const [taskDraft, setTaskDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [updatingTasks, setUpdatingTasks] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState("");
  const [dataError, setDataError] = useState("");
  const [memories, setMemories] = useState<Mem[]>([]);
  const [goals, setGoals] = useState<GoalGroup[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityStatus, setActivityStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [activityUpdatedAt, setActivityUpdatedAt] = useState<number>();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState("");
  const [showBanner, setShowBanner] = useState(true);

  const isComplete = (status?: string) =>
    ["completed", "complete", "done", "succeeded"].includes((status || "").toLowerCase());

  const activeGoals = goals.flatMap(({ goal, tasks }) => {
    const openTasks = tasks.filter((task) => !isComplete(task.status));
    if (isComplete(goal.status) || (tasks.length > 0 && openTasks.length === 0)) return [];
    return [{ goal, tasks: openTasks }];
  });

  useEffect(() => {
    let mounted = true;
    let requestPending = false;
    const loadActivity = async () => {
      if (requestPending || document.visibilityState === "hidden") return;
      requestPending = true;
      try {
        const response = await fetch(API + "/api/agents/activity", {
          headers: { "X-User-ID": "demo-user" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Activity feed unavailable");
        const data: { activity: Activity[] } = await response.json();
        if (mounted) {
          setActivities(data.activity || []);
          setActivityStatus("live");
          setActivityUpdatedAt(Date.now());
        }
      } catch {
        if (mounted) setActivityStatus("offline");
      } finally {
        requestPending = false;
      }
    };
    void loadActivity();
    const timer = window.setInterval(() => void loadActivity(), 2500);
    document.addEventListener("visibilitychange", loadActivity);
    window.addEventListener("focus", loadActivity);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", loadActivity);
      window.removeEventListener("focus", loadActivity);
    };
  }, []);

  const refresh = useCallback(async () => {
    const load = async (path: string) => {
      try {
        const response = await fetch(API + path, { headers, cache: "no-store" });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };
    const [m, g, a, gr, s] = await Promise.all(
      ["/api/memories", "/api/goals", "/api/agents/activity", "/api/graph", "/api/sessions"].map(load)
    );
    if (m) setMemories(m.memories || []);
    if (g) setGoals(g.goals || []);
    if (a) {
      setActivities(a.activity || []);
      setActivityStatus("live");
      setActivityUpdatedAt(Date.now());
    }
    if (gr) {
      setNodes(gr.nodes || []);
      setEdges(gr.edges || []);
      setGraphError("");
    } else {
      setGraphError("Could not load the memory graph. Retry when the API is available.");
    }
    if (s) setSessions(s.sessions || []);
    setDataError(
      [m, g, a, gr, s].some((result) => result === null)
        ? "Some workspace data could not be loaded. Check the API connection and retry."
        : ""
    );
    setGraphLoading(false);
  }, []);

  async function retryGraph() {
    if (!nodes.length) setGraphLoading(true);
    await refresh();
  }

  useEffect(() => {
    const saved = localStorage.getItem("graphmind-session");
    if (saved) {
      setSid(saved);
      fetch(API + `/api/sessions/${encodeURIComponent(saved)}/messages`, { headers, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Conversation unavailable"))))
        .then((d) =>
          setMsgs(
            (d.messages || []).map((m: any) => ({
              role: m.role,
              content: m.content,
              memories: m.role === "assistant" ? m.memories : undefined,
              explanation: m.explanation,
            }))
          )
        )
        .catch(() => setErr("Could not restore the last conversation. Choose it from Recent to retry."));
    }
    void refresh();
  }, [refresh]);

  async function send(customText?: string) {
    const text = (customText || input).trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((v) => [...v, { role: "user", content: text }]);
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(API + "/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: text, session_id: sid }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.detail || "Request failed");
      setSid(d.session_id);
      localStorage.setItem("graphmind-session", d.session_id);
      setMsgs((v) => [
        ...v,
        { role: "assistant", content: d.answer, memories: d.memories, explanation: d.explanation },
      ]);
      await refresh();
    } catch (e: any) {
      setErr(e.message || "Could not reach GraphMind API. Start the Docker services first.");
    } finally {
      setBusy(false);
    }
  }

  async function newChat() {
    setSid(undefined);
    localStorage.removeItem("graphmind-session");
    setMsgs([]);
    setInput("");
    setPage("Chat");
  }

  async function openSession(id: string) {
    setErr("");
    try {
      const r = await fetch(API + `/api/sessions/${encodeURIComponent(id)}/messages`, { headers, cache: "no-store" });
      if (!r.ok) throw Error("Could not load this conversation.");
      const d = await r.json();
      setSid(id);
      localStorage.setItem("graphmind-session", id);
      setMsgs(
        (d.messages || []).map((m: any) => ({
          role: m.role,
          content: m.content,
          memories: m.role === "assistant" ? m.memories : undefined,
          explanation: m.explanation,
        }))
      );
      setPage("Chat");
    } catch (e: any) {
      setErr(e.message || "Could not load this conversation.");
    }
  }

  async function status(task: Node, value: string) {
    if (updatingTasks.has(task.id)) return;
    setUpdatingTasks((current) => new Set(current).add(task.id));
    setActionError("");
    try {
      const response = await fetch(API + `/api/tasks/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: value }),
      });
      if (!response.ok) throw new Error("Task update failed. Please retry.");
      setGoals((current) =>
        current.map((group) => ({
          ...group,
          tasks: group.tasks.map((item) => (item.id === task.id ? { ...item, status: value } : item)),
        }))
      );
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not update the task.");
    } finally {
      setUpdatingTasks((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  async function addTask() {
    if (!taskDraft.trim() || taskSaving) return;
    setTaskSaving(true);
    setActionError("");
    try {
      const goal = activeGoals[0]?.goal;
      const response = await fetch(API + "/api/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: taskDraft.trim(), goal_id: goal?.id, status: "pending" }),
      });
      if (!response.ok) throw new Error("Task could not be added. Please retry.");
      setTaskDraft("");
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not add the task.");
    } finally {
      setTaskSaving(false);
    }
  }

  async function reflect() {
    if (reflecting) return;
    setReflecting(true);
    setActionError("");
    try {
      const response = await fetch(API + "/api/agents/reflect", { method: "POST", headers });
      if (!response.ok) throw new Error("Reflection failed. Please retry.");
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not run reflection.");
    } finally {
      setReflecting(false);
    }
  }

  function agentStatus(name: string) {
    const latest = activities.find((activity) => activity.name === name);
    if (busy && name === "Memory Agent") return "Processing current message";
    if (!latest) return "Waiting for first run";
    if (latest.status === "running") return `Running · ${latest.operation}`;
    return `Last ${latest.status} · ${latest.operation}`;
  }

  const activityIndicator =
    activityStatus === "live"
      ? `LIVE${activityUpdatedAt ? ` · ${new Date(activityUpdatedAt).toLocaleTimeString()}` : ""}`
      : activityStatus === "connecting"
      ? "CONNECTING…"
      : "OFFLINE · retrying";

  const tabs = ["Chat", "Memory Graph", "Goals & Tasks", "Agent Activity"];
  const isChatEmpty = msgs.length === 0 && !busy;

  return (
    <div className="layout">
      {/* Left Sidebar */}
      <aside className="side">
        <div className="brand">
          <div className="logo">G</div>
          <span>GraphMind OS</span>
        </div>

        <button className="new" onClick={newChat}>
          <span>＋</span> <span>New conversation</span>
        </button>

        <div className="navlabel">WORKSPACE</div>
        {tabs.map((t, i) => (
          <button
            type="button"
            aria-current={page === t ? "page" : undefined}
            onClick={() => setPage(t)}
            className={`nav ${page === t ? "active" : ""}`}
            key={t}
          >
            <b>{["◉", "⌘", "◎", "◷"][i]}</b>
            <span>{t}</span>
          </button>
        ))}

        <div className="navlabel">RECENT CHATS</div>
        {sessions.slice(0, 8).map((s: any) => (
          <button
            type="button"
            className={`nav recent-session ${sid === s.id ? "active" : ""}`}
            key={s.id}
            onClick={() => openSession(s.id)}
            title={s.title}
            aria-pressed={sid === s.id}
          >
            <b>◷</b>
            <span>{s.title || "Conversation"}</span>
          </button>
        ))}
        {!sessions.length && <div className="nav">◷ <span>No conversations yet</span></div>}

        <div className="workspace">
          <div className="avatar">
            <i>A</i>
            <span className="label">
              Demo Workspace<br />
              <small>demo-user</small>
            </span>
          </div>
        </div>
      </aside>

      {/* Main Content (Direct, no block transition animation) */}
      <main className="main">
        {/* Top Header with Pill Switcher */}
        <header className="top">
          <div>
            <div className="eyebrow">Agent Memory System</div>
            <h1 className="title">{page}</h1>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* Pill Tabs Segmented Control */}
            <div className="pill-tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={page === t}
                  className={`pill-tab ${page === t ? "active" : ""}`}
                  onClick={() => setPage(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="status" role="status">
              <i className="dot" />
              {graphError
                ? "Graph unavailable"
                : dataError
                ? "Some data unavailable"
                : busy
                ? "Agents working…"
                : "Graph connected"}
            </div>
          </div>
        </header>

        {/* ─────────────────────────────────────────────────────────────
            PAGE 1: CHAT
            Initial State: ONLY CHATBAR with warm hero & quick chips
            Expanded State: Expands to full conversation view + sidebar rail
           ───────────────────────────────────────────────────────────── */}
        {page === "Chat" && (
          <>
            {isChatEmpty ? (
              /* ONLY CHATBAR VIEW (Initial Minimalist State) */
              <div className="chat-hero-container">
                <h2 className="chat-hero-greeting">Let’s start strong!</h2>
                <p className="chat-hero-sub">
                  Ask about your goals, tasks, or graph memory. Your agents continuously learn and reason.
                </p>

                {/* Terracotta Accent Banner Card (Matching Picture) */}
                {showBanner && (
                  <div className="terracotta-banner" style={{ width: "100%", textAlign: "center" }}>
                    <div className="terracotta-icon-badge">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                      </svg>
                    </div>
                    <div className="banner-title">
                      Persistent graph memory with FalkorDB & multi-agent reasoning.
                    </div>
                    <div className="banner-actions">
                      <button className="pill-btn-translucent" onClick={() => setShowBanner(false)}>
                        Dismiss
                      </button>
                      <button className="pill-btn-white" onClick={() => setPage("Memory Graph")}>
                        Explore Graph
                      </button>
                    </div>
                  </div>
                )}

                {/* Summary Stat Pill Card */}
                <div className="summary-card" style={{ width: "100%", marginBottom: 24 }}>
                  <div style={{ textAlign: "left" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                      Connected to FalkorDB Memory
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                      {nodes.length} nodes · {edges.length} relationships active
                    </div>
                  </div>
                  <div className="terracotta-badge-orange">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                    </svg>
                  </div>
                </div>

                {/* The Floating Chatbar */}
                <form
                  className="chatbar-floating-wrapper"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <div className="chatbar-pill">
                    <input
                      type="text"
                      className="chatbar-input"
                      placeholder="What should I work on next? Or enter a new goal…"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      disabled={busy}
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="chatbar-send-btn"
                      disabled={busy || !input.trim()}
                      aria-label="Send message"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13" />
                        <polygon points="22 2 15 22 11 13 2 9 22 2" />
                      </svg>
                    </button>
                  </div>
                </form>

                {err && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 12 }}>{err}</div>}

                {/* Quick Suggestion Chips */}
                <div className="pill-chips-grid">
                  {SUGGESTIONS.map((s, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="pill-chip"
                      onClick={() => void send(s.text)}
                      disabled={busy}
                    >
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              /* EXPANDED CONVERSATION VIEW (Appears when message entered) */
              <div className="chat-expanded-layout">
                <section className="chatbox-expanded">
                  <div className="chathead">
                    <div className="chathead-left">
                      <span>✧ {sid ? "Continuing conversation" : "Active conversation"}</span>
                      <span className="chathead-badge">Graph Memory Active</span>
                    </div>
                    <button className="pill-tab" onClick={newChat} style={{ fontSize: 11, padding: "5px 12px" }}>
                      ＋ New conversation
                    </button>
                  </div>

                  <div className="messages">
                    {msgs.map((m, i) => (
                      <div className={`bubble ${m.role}`} key={i}>
                        <div className="meta">
                          {m.role === "user" ? "You" : "GraphMind · Memory + Planner Agents"}
                        </div>
                        {m.content}
                        {m.memories && m.memories.length > 0 && (
                          <>
                            <div>
                              <span className="tag">{m.memories.length} graph memories retrieved</span>
                            </div>
                            <details className="why">
                              <summary>Why this answer? (Graph path & evidence)</summary>
                              <p>{m.explanation}</p>
                              {m.memories.map((x) => (
                                <div className="memory" key={x.id}>
                                  <b>{x.type}</b> · {x.content}
                                  <br />
                                  <span className="small">
                                    {x.path?.join(" → ")} {x.confidence ? ` · confidence ${x.confidence}` : ""}
                                  </span>
                                </div>
                              ))}
                            </details>
                          </>
                        )}
                      </div>
                    ))}

                    {busy && (
                      <div className="bubble assistant">
                        <div className="meta">Memory Agent · querying FalkorDB</div>
                        Traversing connected goals, tasks, and memory paths…
                      </div>
                    )}
                  </div>

                  {/* Docked Chatbar at bottom of conversation */}
                  <div className="composer-docked">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send();
                      }}
                    >
                      <div className="chatbar-pill" style={{ height: 56 }}>
                        <input
                          type="text"
                          className="chatbar-input"
                          placeholder="Type your response or question…"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          disabled={busy}
                          autoFocus
                        />
                        <button
                          type="submit"
                          className="chatbar-send-btn"
                          style={{ width: 42, height: 42 }}
                          disabled={busy || !input.trim()}
                          aria-label="Send"
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13" />
                            <polygon points="22 2 15 22 11 13 2 9 22 2" />
                          </svg>
                        </button>
                      </div>
                    </form>
                    {err && <div style={{ color: "var(--red)", fontSize: 11, paddingTop: 6 }}>{err}</div>}
                    <div className="hint">Press Enter to send · Memories persist across sessions</div>
                  </div>
                </section>

                {/* Right Rail in Expanded View */}
                <aside className="rail">
                  <div className="card">
                    <div className="cardtitle">
                      <span>Agent Activity</span>
                      <span className="small" aria-live="polite">
                        {activityIndicator}
                      </span>
                    </div>
                    {["Memory Agent", "Planner Agent"].map((x, i) => (
                      <div className="agent" key={x}>
                        <div className="agenticon">{i ? "↗" : "✧"}</div>
                        <div>
                          <b style={{ color: "var(--text)" }}>{x}</b>
                          <br />
                          <span className="small">{agentStatus(x)}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="card">
                    <div className="cardtitle">
                      <span>Memory Graph</span>
                      <span className="small">LIVE DATA</span>
                    </div>
                    <div className="count">{nodes.length}</div>
                    <div className="small">connected nodes · {edges.length} relationships</div>
                  </div>

                  <div className="card">
                    <div className="cardtitle">Recent Memories</div>
                    {memories.slice(0, 3).map((m) => (
                      <div className="memory" key={m.id}>
                        {m.content}
                        <br />
                        <span className="tag">{m.kind || m.type || "memory"}</span>
                      </div>
                    ))}
                    {!memories.length && (
                      <div className="small">Your saved facts and tasks will appear here.</div>
                    )}
                  </div>
                </aside>
              </div>
            )}
          </>
        )}

        {/* ─────────────────────────────────────────────────────────────
            PAGE 2: MEMORY GRAPH
           ───────────────────────────────────────────────────────────── */}
        {page === "Memory Graph" && (
          <MemoryGraph
            nodes={nodes}
            edges={edges}
            loading={graphLoading}
            error={graphError || undefined}
            onRetry={retryGraph}
          />
        )}

        {/* ─────────────────────────────────────────────────────────────
            PAGE 3: GOALS & TASKS
           ───────────────────────────────────────────────────────────── */}
        {page === "Goals & Tasks" && (
          <>
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="cardtitle">Add a Task</div>
              <div className="compose">
                <input
                  value={taskDraft}
                  onChange={(e) => setTaskDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !taskSaving && addTask()}
                  placeholder="What needs to get done?"
                  disabled={taskSaving}
                  style={{ background: "transparent", border: 0, color: "var(--text)", outline: 0, flex: 1, fontSize: 13 }}
                />
                <button className="send" onClick={addTask} disabled={taskSaving || !taskDraft.trim()}>
                  {taskSaving ? "Adding…" : "Add task"}
                </button>
              </div>
              {actionError && <p role="alert" className="small" style={{ color: "var(--red)", marginTop: 8 }}>{actionError}</p>}
            </div>

            <div className="pagegrid">
              {activeGoals.map(({ goal, tasks }) => (
                <div className="card" key={goal.id}>
                  <div className="cardtitle">
                    <span>Active Goal</span>
                    <span className="tag">{goal.status}</span>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14, color: "var(--text)" }}>
                    {goal.title}
                  </div>
                  {tasks.map((t: Node) => (
                    <div className="taskrow" key={t.id}>
                      <span>{t.title}</span>
                      <select
                        value={t.status || "pending"}
                        disabled={updatingTasks.has(t.id)}
                        onChange={(e) => status(t, e.target.value)}
                      >
                        <option>pending</option>
                        <option>in_progress</option>
                        <option>completed</option>
                        <option>blocked</option>
                      </select>
                    </div>
                  ))}
                </div>
              ))}
              {!activeGoals.length && (
                <div className="card small">
                  {goals.length
                    ? "Everything is complete. Share a new goal in Chat when ready."
                    : "Share a goal in Chat and it will be stored with its tasks in FalkorDB."}
                </div>
              )}
            </div>
          </>
        )}

        {/* ─────────────────────────────────────────────────────────────
            PAGE 4: AGENT ACTIVITY
           ───────────────────────────────────────────────────────────── */}
        {page === "Agent Activity" && (
          <div className="card">
            <div className="cardtitle">
              <span>Shared Agent Event Log <span className="small" aria-live="polite">{activityIndicator}</span></span>
              <button className="send" onClick={reflect} disabled={reflecting}>
                {reflecting ? "Reflecting…" : "Run reflection"}
              </button>
            </div>
            {actionError && <p role="alert" className="small" style={{ color: "var(--red)" }}>{actionError}</p>}
            {activities.map((a, i) => (
              <div className="agent" key={a.id || i}>
                <div className="agenticon">✧</div>
                <div>
                  <b style={{ color: "var(--text)" }}>{a.name}</b> · <span style={{ color: "var(--terracotta)", fontWeight: 600 }}>{a.status}</span>
                  <br />
                  {a.operation}
                  <br />
                  <span className="small">
                    {a.created_at} · {Array.isArray(a.memories_affected) ? a.memories_affected.length : 0} memories affected{" "}
                    {a.detail && `· ${a.detail}`}
                  </span>
                </div>
              </div>
            ))}
            {!activities.length && (
              <div className="small">Agent operations will appear here after your first message.</div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
