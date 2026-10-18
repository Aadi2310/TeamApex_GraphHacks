import os, re, uuid
from typing import Optional
try:
    from dotenv import load_dotenv
    load_dotenv(override=True)
except ImportError:
    pass
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from . import graph

app = FastAPI(title="GraphMind OS API", version="0.1.0", description="Graph-backed shared memory and agent coordination API.")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3001", "http://127.0.0.1:3001"], allow_methods=["*"], allow_headers=["*"])

def uid(x: Optional[str]):
    value = x or os.getenv("USER_ID", "demo-user")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,100}", value):
        raise HTTPException(400, "Invalid X-User-ID")
    return value

@app.on_event("startup")
def startup():
    try:
        graph.connect()
    except Exception as e:
        print(f"FalkorDB unavailable; graph-backed endpoints will return 503: {e}")

@app.exception_handler(Exception)
async def errors(_, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=503, content={"detail": f"GraphMind service error: {str(exc)}. Confirm FalkorDB is running and configured."})

def body(result):
    return result

class ChatInput(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    session_id: Optional[str] = None

class TaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=2000)
    goal_id: Optional[str] = None
    status: str = Field(default="pending", pattern="^(pending|in_progress|completed|blocked)$")
    priority: str = Field(default="medium", pattern="^(low|medium|high|critical)$")

class TaskPatch(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=300)
    description: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[str] = Field(default=None, pattern="^(pending|in_progress|completed|blocked)$")
    priority: Optional[str] = Field(default=None, pattern="^(low|medium|high|critical)$")

class ProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    status: str = Field(default="active", pattern="^(active|paused|completed)$")

class PersonInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    role: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=2000)

class MistakeInput(BaseModel):
    description: str = Field(min_length=1, max_length=1000)
    prevention_rule: str = Field(default="", max_length=1000)
    task_id: Optional[str] = None
    severity: str = Field(default="medium", pattern="^(low|medium|high|critical)$")

class HabitInput(BaseModel):
    pattern: str = Field(min_length=1, max_length=1000)
    strength: float = Field(default=1.0, ge=0.0, le=5.0)
    context: str = Field(default="", max_length=1000)

class DependencyInput(BaseModel):
    depends_on_task_id: str = Field(min_length=1)

def extract(text):
    """Deterministic local extractor; extracts goals, tasks, mistakes, habits, projects, and people."""
    found = []
    goal_match = re.search(r"(?:my goal is to|goal is to|goal:?)\s+(.+?)(?:[.!?]|$)", text, re.I)
    if goal_match:
        found.append(("goal", goal_match.group(1).strip()))
        
    # Explicit task status phrases, including the hackathon demo sentence.
    for m in re.finditer(r"(?:completed|finished|done with)\s+(?:the\s+)?([^,.!?]+)", text, re.I):
        found.append(("completed", re.sub(r"^(?:but|and)\s+", "", m.group(1).strip(), flags=re.I)))
    for m in re.finditer(r"(?:still\s+pending|pending|not started|haven't started)\s+(?:is\s+)?(?:the\s+)?([^,.!?]+)", text, re.I):
        found.append(("pending", re.sub(r"^(?:but|and)\s+", "", m.group(1).strip(), flags=re.I)))
    for m in re.finditer(r"(?:the\s+)?([^,.!?]+?)\s+(?:is|are)\s+(?:still\s+)?pending\b", text, re.I):
        found.append(("pending", re.sub(r"^(?:but|and)\s+", "", m.group(1).strip(), flags=re.I)))
        
    # Mistakes / Lessons learned
    mistake_match = re.search(r"(?:mistake was|learned that|lesson learned:?|avoid:?)\s+(.+?)(?:[.!?]|$)", text, re.I)
    if mistake_match:
        found.append(("mistake", mistake_match.group(1).strip()))
        
    # Habits / Preferences
    habit_match = re.search(r"(?:prefer to|preference is to|habit:?|always)\s+(.+?)(?:[.!?]|$)", text, re.I)
    if habit_match:
        found.append(("habit", habit_match.group(1).strip()))

    # Project mentions
    proj_match = re.search(r"(?:project:?|working on project)\s+(.+?)(?:[.!?]|$)", text, re.I)
    if proj_match:
        found.append(("project", proj_match.group(1).strip()))

    if "goal" not in [k for k, _ in found]:
        # Capture project targets as a durable fact even when not written with "goal".
        m = re.search(r"(?:building|working on|project is)\s+(.+?)(?:[.!?]|$)", text, re.I)
        if m:
            found.append(("fact", m.group(0).strip()))
    return found

async def answer_llm(prompt, contexts):
    provider = os.getenv("LLM_PROVIDER", "deterministic").lower()
    if provider in ("deterministic", "test", ""):
        return "I saved this to your shared graph memory. " + ("Based on your active goal and tasks, graph retrieval is the next useful step." if "what should" in prompt.lower() or "next" in prompt.lower() else "I’ll use these connected memories in future sessions.")
    key = os.getenv("LLM_API_KEY")
    if not key:
        raise HTTPException(503, "LLM_PROVIDER is configured for an external provider, but LLM_API_KEY is missing. Set deterministic for local demos.")
    import httpx
    if provider == "openai":
        async with httpx.AsyncClient(timeout=45) as c:
            r = await c.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
                    "messages": [
                        {"role": "system", "content": "Answer only using the supplied retrieved graph context. State when context is insufficient. Do not claim unsupported facts."},
                        {"role": "user", "content": f"Graph context: {contexts}\nQuestion: {prompt}"}
                    ]
                }
            )
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
    raise HTTPException(400, "Unsupported LLM_PROVIDER. Use deterministic or openai.")

@app.get("/api/health")
def health():
    try:
        graph.query("RETURN 1 AS ok")
        return {"status": "ok", "graph": "connected"}
    except Exception as e:
        raise HTTPException(503, detail=f"FalkorDB unavailable: {e}")

@app.post("/api/chat")
async def chat(data: ChatInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    session = data.session_id or "session-" + uuid.uuid4().hex
    graph.ensure_user(user)
    graph.save_message(user, session, "user", data.message)
    graph.log_agent(user, "Memory Agent", "extract and persist message", "running")
    affected = []
    goal_id = None
    try:
        for kind, value in extract(data.message):
            if kind == "goal":
                goal_id = graph.upsert_goal(user, value)
                mid = graph.upsert_memory(user, value, "goal", "user", 1.0, session, goal_id)
                affected.append(mid)
            elif kind in ("completed", "pending"):
                tid = graph.upsert_task(user, value, "completed" if kind == "completed" else "pending", goal_id)
                mid = graph.upsert_memory(user, f"Task {value} is {kind}.", "task_status", "user", 1.0, session, tid)
                affected.append(mid)
            elif kind == "mistake":
                mid_m = graph.upsert_mistake(user, value, "Avoid repeating this failure pattern")
                affected.append(mid_m)
            elif kind == "habit":
                hid = graph.upsert_habit(user, value)
                affected.append(hid)
            elif kind == "project":
                pid = graph.upsert_project(user, value)
                affected.append(pid)
            else:
                affected.append(graph.upsert_memory(user, value, "fact", "user", 1.0, session))
                
        # Link extracted task states to an existing active goal when the goal was saved in an earlier turn.
        if goal_id is None and affected:
            gs = graph.goals(user)
            goal_id = graph.node_props(gs[0].get("g")).get("id") if gs else None
            if goal_id:
                for kind, value in extract(data.message):
                    if kind in ("completed", "pending"):
                        graph.upsert_task(user, value, "completed" if kind == "completed" else "pending", goal_id)
                        
        graph.log_agent(user, "Memory Agent", "persist structured memories", "succeeded", affected)
    except Exception as e:
        graph.log_agent(user, "Memory Agent", "persist structured memories", "failed", affected, str(e))
        raise

    retrieved = graph.retrieve(user, data.message)
    graph.log_agent(user, "Memory Agent", "retrieve connected graph context", "succeeded", [x["id"] for x in retrieved])
    
    if "what should" in data.message.lower() or "next" in data.message.lower():
        graph.log_agent(user, "Planner Agent", "traverse active goals, tasks, and linked memories", "running")
        pending = [m.get("title") or m.get("content") for m in retrieved if m.get("type") == "task" and m.get("status") in ("pending", "in_progress", "blocked")]
        # Include all graph-visible tasks, even when the question's lexical overlap is low.
        for group in graph.goals(user):
            for task in group.get("tasks") or []:
                p = graph.node_props(task)
                if p.get("status") in ("pending", "in_progress", "blocked") and p.get("title") and p.get("title") not in pending:
                    pending.append(p["title"])
        if pending:
            rec_task = pending[0]
            # Check if any lessons/mistakes warn against this task or domain
            warn_items = [m.get("content") for m in retrieved if m.get("type") == "mistake"]
            warning_text = f" (⚠️ Note: {warn_items[0]})" if warn_items else ""
            text = f"Based on your active goal and its connected task statuses, work next on **{rec_task}**.{warning_text} This task is still open in the graph, while completed tasks remain marked done."
        else:
            known = [graph.node_props(t).get("title") for group in graph.goals(user) for t in (group.get("tasks") or []) if graph.node_props(t).get("title")]
            text = ("All tasks currently connected to your active goal are marked complete. Add or update a task to get a new recommendation." if known else await answer_llm(data.message, retrieved))
        graph.log_agent(user, "Planner Agent", "recommend next action from graph-connected tasks", "succeeded", [m["id"] for m in retrieved])
    else:
        text = await answer_llm(data.message, retrieved)
        
    graph.save_message(user, session, "assistant", text, retrieved, "These graph-connected memories were retrieved for this answer; paths list the relationships traversed in FalkorDB.")
    return {
        "session_id": session,
        "answer": text,
        "memories": retrieved,
        "explanation": "These graph-connected memories were retrieved for this answer; paths list the relationships traversed in FalkorDB.",
        "agents": ["Memory Agent", "Planner Agent"]
    }

@app.get("/api/sessions")
def sessions(x_user_id: Optional[str] = Header(None)):
    return {"sessions": [graph.node_props(x.get("s")) for x in graph.list_sessions(uid(x_user_id))]}

@app.get("/api/sessions/{session_id}/messages")
def session_messages(session_id: str, x_user_id: Optional[str] = Header(None)):
    import json
    result = []
    for x in graph.messages(uid(x_user_id), session_id):
        message = graph.node_props(x.get("m"))
        raw = message.pop("evidence_json", "[]")
        try:
            message["memories"] = json.loads(raw)
        except (TypeError, ValueError):
            message["memories"] = []
        result.append(message)
    return {"messages": result}

@app.get("/api/memories")
def get_memories(x_user_id: Optional[str] = Header(None)):
    return {"memories": [graph.node_props(x.get("m")) for x in graph.memories(uid(x_user_id))]}

@app.get("/api/graph")
def get_graph(x_user_id: Optional[str] = Header(None)):
    return graph.graph_data(uid(x_user_id))

@app.get("/api/goals")
def get_goals(x_user_id: Optional[str] = Header(None)):
    return {"goals": [{"goal": graph.node_props(x.get("g")), "tasks": [graph.node_props(t) for t in (x.get("tasks") or []) if t]} for x in graph.goals(uid(x_user_id))]}

@app.post("/api/tasks")
def create_task(data: TaskInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    tid = graph.upsert_task(user, data.title, data.status, data.goal_id, data.description, data.priority)
    mid = graph.upsert_memory(user, f"Task created: {data.title} ({data.status}).", "task_update", "user", 1.0, related_id=tid)
    graph.log_agent(user, "Memory Agent", "save task update", "succeeded", [mid, tid])
    return {"id": tid, "status": data.status}

@app.patch("/api/tasks/{task_id}")
def update_task(task_id: str, data: TaskPatch, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    updates = data.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "Provide at least one field to update")
    # User-scoped match prevents cross-user task updates.
    graph.query("MATCH (t:Task {id:$id,user_id:$uid}) SET t += $updates,t.updated_at=$now RETURN t", {"id": task_id, "uid": user, "updates": updates, "now": graph.utcnow()})
    # Verify ownership/existence and add durable update context.
    check = graph.query("MATCH (t:Task {id:$id,user_id:$uid}) RETURN t", {"id": task_id, "uid": user})
    if not check.result_set:
        raise HTTPException(404, "Task not found")
    mid = graph.upsert_memory(user, "Task updated: " + str(updates), "task_update", "user", 1.0, related_id=task_id)
    graph.log_agent(user, "Memory Agent", "update task and shared graph memory", "succeeded", [mid, task_id])
    return {"id": task_id, "updated": updates}

@app.post("/api/tasks/{task_id}/dependency")
def add_task_dependency(task_id: str, data: DependencyInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    graph.add_task_dependency(user, task_id, data.depends_on_task_id)
    graph.log_agent(user, "Planner Agent", "link task dependency in graph", "succeeded", [task_id, data.depends_on_task_id])
    return {"status": "ok", "task_id": task_id, "depends_on": data.depends_on_task_id}

@app.get("/api/projects")
def get_projects(x_user_id: Optional[str] = Header(None)):
    return {"projects": [graph.node_props(x.get("p")) for x in graph.projects(uid(x_user_id))]}

@app.post("/api/projects")
def create_project(data: ProjectInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    pid = graph.upsert_project(user, data.name, data.description, data.status)
    graph.log_agent(user, "Memory Agent", "create project", "succeeded", [pid])
    return {"id": pid, "name": data.name, "status": data.status}

@app.get("/api/people")
def get_people(x_user_id: Optional[str] = Header(None)):
    return {"people": [graph.node_props(x.get("p")) for x in graph.people(uid(x_user_id))]}

@app.post("/api/people")
def create_person(data: PersonInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    pid = graph.upsert_person(user, data.name, data.role, data.email, data.notes)
    graph.log_agent(user, "Memory Agent", "save person contact", "succeeded", [pid])
    return {"id": pid, "name": data.name}

@app.get("/api/mistakes")
def get_mistakes(x_user_id: Optional[str] = Header(None)):
    return {"mistakes": [graph.node_props(x.get("m")) for x in graph.mistakes(uid(x_user_id))]}

@app.post("/api/mistakes")
def create_mistake(data: MistakeInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    mid = graph.upsert_mistake(user, data.description, data.prevention_rule, data.task_id, data.severity)
    graph.log_agent(user, "Reflection Agent", "record lesson learned to prevent repeated mistakes", "succeeded", [mid])
    return {"id": mid, "description": data.description}

@app.get("/api/habits")
def get_habits(x_user_id: Optional[str] = Header(None)):
    return {"habits": [graph.node_props(x.get("h")) for x in graph.habits(uid(x_user_id))]}

@app.post("/api/habits")
def create_habit(data: HabitInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    hid = graph.upsert_habit(user, data.pattern, data.strength, data.context)
    graph.log_agent(user, "Memory Agent", "record habit / user preference", "succeeded", [hid])
    return {"id": hid, "pattern": data.pattern}

@app.post("/api/agents/reflect")
def reflect(x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    mems = [graph.node_props(x.get("m")) for x in graph.memories(user)]
    reviewed = []
    conflicts = []
    for m in mems:
        if not m.get("content"):
            continue
        reviewed.append(m.get("id"))
        for n in mems:
            if (
                n.get("id") != m.get("id")
                and m.get("kind") == n.get("kind")
                and m.get("content")
                and n.get("content")
                and m["content"].lower() != n["content"].lower()
                and m["content"].split(":")[0].lower() == n["content"].split(":")[0].lower()
            ):
                conflicts.append([m.get("id"), n.get("id")])
                try:
                    graph.mark_conflict(user, m.get("id"), n.get("id"), "Opposing statements on same topic")
                except Exception:
                    pass
    conflict_count = len(set(tuple(sorted(x)) for x in conflicts))
    graph.log_agent(
        user,
        "Reflection Agent",
        "review duplicates and possible conflicts",
        "succeeded",
        reviewed,
        f"{conflict_count} potential conflicts flagged in graph; no history deleted."
    )
    return {
        "reviewed": len(reviewed),
        "potential_conflicts": list({tuple(x) for x in conflicts}),
        "note": "Potential conflicts are surfaced for review and connected with [:CONTRADICTS] in FalkorDB; uncertain information is not automatically superseded."
    }

@app.get("/api/agents/activity")
def agent_activity(x_user_id: Optional[str] = Header(None)):
    import json
    items = []
    for x in graph.activity(uid(x_user_id)):
        item = graph.node_props(x.get("a"))
        raw = item.pop("memories_affected_json", "[]")
        try:
            item["memories_affected"] = json.loads(raw)
        except (TypeError, ValueError):
            item["memories_affected"] = []
        items.append(item)
    return {"activity": items}

