import os
import re
import uuid
import asyncio
import logging
from typing import Optional
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from . import graph

app = FastAPI(title="GraphMind OS API", version="0.1.0", description="Graph-backed shared memory and agent coordination API.")
logger = logging.getLogger(__name__)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3001", "http://127.0.0.1:3001"], allow_methods=["*"], allow_headers=["*"])

def uid(x: Optional[str]):
    value = x or os.getenv("USER_ID") or "demo-user"
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,100}", value):
        raise HTTPException(400, "Invalid X-User-ID")
    return value

@app.on_event("startup")
def startup():
    try:
        graph.connect()
    except Exception as exc:
        logger.warning("FalkorDB startup connection failed (%s). Graph endpoints will fail until it is available.", type(exc).__name__)

@app.exception_handler(Exception)
async def errors(_, exc):
    from fastapi.responses import JSONResponse
    logger.error("Unhandled API exception (%s)", type(exc).__name__)
    return JSONResponse(status_code=500, content={"detail": "The request could not be completed. Please retry."})

def body(result):
    return result

class APIInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

class ChatInput(APIInput):
    message: str = Field(min_length=1, max_length=8000)
    session_id: Optional[str] = Field(default=None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")

class TaskInput(APIInput):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=2000)
    goal_id: Optional[str] = Field(default=None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    status: str = Field(default="pending", pattern="^(pending|in_progress|completed|blocked)$")
    priority: str = Field(default="medium", pattern="^(low|medium|high|critical)$")

class TaskPatch(APIInput):
    title: Optional[str] = Field(default=None, min_length=1, max_length=300)
    description: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[str] = Field(default=None, pattern="^(pending|in_progress|completed|blocked)$")
    priority: Optional[str] = Field(default=None, pattern="^(low|medium|high|critical)$")

class ProjectInput(APIInput):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    status: str = Field(default="active", pattern="^(active|paused|completed)$")

class PersonInput(APIInput):
    name: str = Field(min_length=1, max_length=200)
    role: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=2000)

class MistakeInput(APIInput):
    description: str = Field(min_length=1, max_length=1000)
    prevention_rule: str = Field(default="", max_length=1000)
    task_id: Optional[str] = Field(default=None, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    severity: str = Field(default="medium", pattern="^(low|medium|high|critical)$")

class HabitInput(APIInput):
    pattern: str = Field(min_length=1, max_length=1000)
    strength: float = Field(default=1.0, ge=0.0, le=5.0)
    context: str = Field(default="", max_length=1000)

class DependencyInput(APIInput):
    depends_on_task_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")

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

def answer_deterministic(prompt, contexts):
    """Give a useful local reply without claiming access to a generative model."""
    message = prompt.strip()
    lowered = message.lower()
    if re.match(r"^(hi|hello|hey|good morning|good afternoon|good evening)\b", lowered):
        return "Hi! What are you working on today? Share a goal, a task, or a question and I’ll help you think it through."

    facts = []
    for memory in contexts:
        fact = (memory.get("title") or memory.get("content") or "").strip()
        if fact and fact not in facts:
            facts.append(fact)
    context = "; ".join(facts[:3])

    if "?" in message or re.match(r"^(what|how|why|when|where|who|can|could|should|do|does|is|are)\b", lowered):
        if context:
            return f"From what you’ve shared, {context}. What part would you like to work through first?"
        return "I can help think that through. Tell me a little about the project or situation so I can give you a useful, specific answer."

    if context:
        return f"Got it — {context}. I’ll keep that in mind as we plan. Would you like help choosing a next step?"
    return "Got it. I’ll keep that in mind for this conversation. What outcome would you like to focus on next?"


def prepare_chat_context(user: str, session: str, message: str):
    """Run the blocking graph work off the ASGI event loop."""
    graph.ensure_user(user)
    graph.save_message(user, session, "user", message)
    graph.log_agent(user, "Memory Agent", "extract and persist message", "running")
    affected = []
    goal_id = None
    try:
        for kind, value in extract(message):
            if kind == "goal":
                goal_id = graph.upsert_goal(user, value)
                mid = graph.upsert_memory(user, value, "goal", "user", 1.0, session, goal_id)
                affected.append(mid)
            elif kind in ("completed", "pending"):
                tid = graph.upsert_task(user, value, "completed" if kind == "completed" else "pending", goal_id)
                mid = graph.upsert_memory(user, f"Task {value} is {kind}.", "task_status", "user", 1.0, session, tid)
                affected.append(mid)
            elif kind == "mistake":
                affected.append(graph.upsert_mistake(user, value, "Avoid repeating this failure pattern"))
            elif kind == "habit":
                affected.append(graph.upsert_habit(user, value))
            elif kind == "project":
                affected.append(graph.upsert_project(user, value))
            else:
                affected.append(graph.upsert_memory(user, value, "fact", "user", 1.0, session))

        if goal_id is None and affected:
            existing_goals = graph.goals(user)
            goal_id = graph.node_props(existing_goals[0].get("g")).get("id") if existing_goals else None
            if goal_id:
                for kind, value in extract(message):
                    if kind in ("completed", "pending"):
                        graph.upsert_task(user, value, "completed" if kind == "completed" else "pending", goal_id)
        graph.log_agent(user, "Memory Agent", "persist structured memories", "succeeded", affected)
        retrieved = graph.retrieve(user, message)
        graph.log_agent(user, "Memory Agent", "retrieve connected graph context", "succeeded", [item["id"] for item in retrieved])

        plan = None
        lowered = message.lower()
        if "what should" in lowered or "next" in lowered:
            graph.log_agent(user, "Planner Agent", "traverse active goals, tasks, and linked memories", "running")
            pending = [item.get("title") or item.get("content") for item in retrieved if item.get("type") == "task" and item.get("status") in ("pending", "in_progress", "blocked")]
            groups = graph.goals(user)
            known = []
            for group in groups:
                for task in group.get("tasks") or []:
                    props = graph.node_props(task)
                    if props.get("title"):
                        known.append(props["title"])
                    if props.get("status") in ("pending", "in_progress", "blocked") and props.get("title") and props["title"] not in pending:
                        pending.append(props["title"])
            warnings = [item.get("content") for item in retrieved if item.get("type") == "mistake" and item.get("content")]
            plan = {"pending": pending, "known": known, "warnings": warnings}
            graph.log_agent(user, "Planner Agent", "recommend next action from graph-connected tasks", "succeeded", [item["id"] for item in retrieved])
        return retrieved, plan
    except Exception as exc:
        try:
            graph.log_agent(user, "Memory Agent", "process chat context", "failed", affected, type(exc).__name__)
        except Exception:
            logger.error("Could not persist a failed chat activity record")
        raise


async def answer_llm(prompt, contexts):
    provider = os.getenv("LLM_PROVIDER", "deterministic").lower()
    if provider in ("deterministic", "test", ""):
        return answer_deterministic(prompt, contexts)
    if provider not in {"openai", "groq"}:
        raise HTTPException(400, "Unsupported LLM_PROVIDER. Use deterministic, openai, or groq.")
    key = (
        os.getenv("GROQ_API_KEY")
        if provider == "groq"
        else os.getenv("OPENAI_API_KEY") or os.getenv("LLM_API_KEY")
    )
    if not key:
        expected_key = "GROQ_API_KEY" if provider == "groq" else "OPENAI_API_KEY"
        raise HTTPException(503, f"{provider.capitalize()} chat is enabled but no API key is set. Add {expected_key} to .env, or set LLM_PROVIDER=deterministic for local replies.")
    import httpx
    if provider in ("openai", "groq"):
        base_url = "https://api.groq.com/openai/v1" if provider == "groq" else "https://api.openai.com/v1"
        model = (
            os.getenv("GROQ_CHAT_MODEL", "openai/gpt-oss-20b")
            if provider == "groq"
            else os.getenv("CHAT_MODEL") or os.getenv("LLM_MODEL", "gpt-4o-mini")
        )
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=10)) as c:
                response = await c.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {key}"},
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": "You are GraphMind, a helpful conversational planning assistant. Answer the user's actual message directly and naturally in 2–5 sentences unless they ask for detail. Use plain text without Markdown syntax because the chat displays plain text. Use supplied graph context when relevant, but do not merely describe the graph. Say when context is insufficient and never claim unsupported facts."},
                            {"role": "user", "content": f"Relevant workspace context: {contexts}\n\nUser message: {prompt}"}
                        ]
                    }
                )
                response.raise_for_status()
                payload = response.json()
                content = payload["choices"][0]["message"]["content"]
                if not isinstance(content, str) or not content.strip():
                    raise ValueError("Empty chat completion")
                return content.strip()
        except httpx.TimeoutException as exc:
            raise HTTPException(504, f"{provider.capitalize()} did not respond in time. Please retry.") from exc
        except httpx.HTTPStatusError as exc:
            logger.warning("%s provider returned HTTP %s", provider, exc.response.status_code)
            raise HTTPException(502, f"{provider.capitalize()} chat request failed. Please retry.") from exc
        except httpx.RequestError as exc:
            logger.warning("%s provider request failed (%s)", provider, type(exc).__name__)
            raise HTTPException(502, f"Could not reach {provider.capitalize()}. Please retry.") from exc
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            logger.warning("%s provider returned an invalid response (%s)", provider, type(exc).__name__)
            raise HTTPException(502, f"{provider.capitalize()} returned an invalid response. Please retry.") from exc
    raise HTTPException(400, "Unsupported LLM_PROVIDER. Use deterministic, openai, or groq.")

@app.get("/api/health")
def health():
    try:
        graph.query("RETURN 1 AS ok")
        return {"status": "ok", "graph": "connected"}
    except Exception as exc:
        logger.warning("FalkorDB health check failed (%s)", type(exc).__name__)
        raise HTTPException(503, detail="FalkorDB is unavailable. Check the database service and retry.") from exc

@app.post("/api/chat")
async def chat(data: ChatInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    session = data.session_id or "session-" + uuid.uuid4().hex
    try:
        retrieved, plan = await asyncio.to_thread(prepare_chat_context, user, session, data.message)
    except Exception as exc:
        logger.warning("Chat graph processing failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Could not save or retrieve chat memory. Check the graph service and retry.") from exc

    if plan is not None:
        pending = plan["pending"]
        known = plan["known"]
        warnings = plan["warnings"]
        if pending:
            warning_text = f" (⚠️ Note: {warnings[0]})" if warnings else ""
            text = f"I’d tackle {pending[0]} next. It’s still open in your plan.{warning_text} Once it’s done, we can choose the next step together."
        elif known:
            text = "All tasks currently connected to your active goal are marked complete. Add or update a task to get a new recommendation."
        else:
            text = await answer_llm(data.message, retrieved)
    else:
        text = await answer_llm(data.message, retrieved)

    try:
        await asyncio.to_thread(graph.save_message, user, session, "assistant", text, retrieved, "These graph-connected memories were retrieved for this answer; paths list the relationships traversed in FalkorDB.")
    except Exception as exc:
        logger.warning("Could not save assistant response (%s)", type(exc).__name__)
        raise HTTPException(503, "The reply was generated but could not be saved. Please retry.") from exc
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
    if data.goal_id and not graph.user_entity_exists("Goal", data.goal_id, user):
        raise HTTPException(404, "Goal not found for this user.")
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
    updated = graph.query("MATCH (t:Task {id:$id,user_id:$uid}) SET t += $updates,t.updated_at=$now RETURN t.id AS id", {"id": task_id, "uid": user, "updates": updates, "now": graph.utcnow()})
    if not updated.result_set:
        raise HTTPException(404, "Task not found")
    mid = graph.upsert_memory(user, "Task updated: " + str(updates), "task_update", "user", 1.0, related_id=task_id)
    graph.log_agent(user, "Memory Agent", "update task and shared graph memory", "succeeded", [mid, task_id])
    return {"id": task_id, "updated": updates}

@app.post("/api/tasks/{task_id}/dependency")
def add_task_dependency(task_id: str, data: DependencyInput, x_user_id: Optional[str] = Header(None)):
    user = uid(x_user_id)
    if task_id == data.depends_on_task_id:
        raise HTTPException(400, "A task cannot depend on itself.")
    if not graph.add_task_dependency(user, task_id, data.depends_on_task_id):
        raise HTTPException(404, "Both tasks must exist in this user's workspace.")
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
    if data.task_id and not graph.user_entity_exists("Task", data.task_id, user):
        raise HTTPException(404, "Task not found for this user.")
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
    comparable = [memory for memory in mems if memory.get("content")]
    for index, m in enumerate(comparable):
        if not m.get("content"):
            continue
        reviewed.append(m.get("id"))
        for n in comparable[index + 1:]:
            if (
                n.get("id") != m.get("id")
                and m.get("kind") == n.get("kind")
                and m.get("content")
                and n.get("content")
                and m["content"].lower() != n["content"].lower()
                and m["content"].split(":")[0].lower() == n["content"].split(":")[0].lower()
            ):
                conflicts.append([m.get("id"), n.get("id")])
                graph.mark_conflict(user, m.get("id"), n.get("id"), "Opposing statements on same topic")
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

