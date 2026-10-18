"""FalkorDB access. Every application query is parameterized and user scoped."""
import os
import json
import hashlib
import uuid
import logging
from datetime import datetime, timezone
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass
try:
    from falkordb import FalkorDB
except ImportError:
    FalkorDB = None

DB = None
GRAPH = None
logger = logging.getLogger(__name__)

def utcnow():    
    return datetime.now(timezone.utc).isoformat()

def connect():
    global DB, GRAPH
    if FalkorDB is None:
        raise RuntimeError("falkordb package not installed. Run 'pip install -r backend/requirements.txt' or run with Docker.")
    DB = FalkorDB(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        username=os.getenv("FALKORDB_USERNAME") or None,
        password=os.getenv("FALKORDB_PASSWORD") or None
    )
    GRAPH = DB.select_graph(os.getenv("FALKORDB_GRAPH", "graphmind"))
    
    # FalkorDB supports CREATE INDEX; duplicate index errors are harmless at startup.
    indexes = (
        "CREATE INDEX FOR (n:User) ON (n.id)",
        "CREATE INDEX FOR (n:Memory) ON (n.user_id)",
        "CREATE INDEX FOR (n:Task) ON (n.user_id)",
        "CREATE INDEX FOR (n:Goal) ON (n.user_id)",
        "CREATE INDEX FOR (n:Project) ON (n.user_id)",
        "CREATE INDEX FOR (n:Person) ON (n.user_id)",
        "CREATE INDEX FOR (n:Mistake) ON (n.user_id)",
        "CREATE INDEX FOR (n:Habit) ON (n.user_id)",
        "CREATE INDEX FOR (n:Session) ON (n.user_id)",
        "CREATE INDEX FOR (n:Message) ON (n.user_id)",
        "CREATE INDEX FOR (n:Agent) ON (n.user_id)",
    )
    for q in indexes:
        try:
            GRAPH.query(q)
        except Exception as exc:
            # Repeated startup commonly encounters already-created indexes. Keep the
            # application available, but leave a diagnostic without exposing query data.
            logger.warning("FalkorDB index setup skipped (%s)", type(exc).__name__)
    return GRAPH

def query(cypher, params=None):
    if GRAPH is None:
        connect()
    return GRAPH.query(cypher, params or {})

def user_entity_exists(label, entity_id, user_id):
    """Check an allowed, user-owned entity before creating graph relationships."""
    if label not in {"Task", "Goal", "Project", "Person", "Mistake", "Habit", "Memory"}:
        raise ValueError("Unsupported graph entity type")
    result = query(
        f"MATCH (n:{label} {{id:$id, user_id:$uid}}) RETURN n.id LIMIT 1",
        {"id": entity_id, "uid": user_id},
    )
    return bool(result.result_set)

def rows(result):
    # FalkorDB's Python client headers are [column_name, column_type] pairs.
    names = [column[1] if isinstance(column, (tuple, list)) and len(column) > 1 else getattr(column, "name", column) for column in result.header]
    return [dict(zip(names, row)) for row in result.result_set]

def node_props(node):
    if isinstance(node, dict):
        return node
    return getattr(node, "properties", {}) or {}

def ensure_user(user_id):
    query(
        "MERGE (u:User {id:$uid}) ON CREATE SET u.created_at=$now SET u.user_id=$uid",
        {"uid": user_id, "now": utcnow()}
    )

def save_message(user_id, session_id, role, content, evidence=None, explanation=""):
    now = utcnow()
    mid = f"msg-{uuid.uuid4()}"
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (s:Session {id:$sid, user_id:$uid}) "
        "ON CREATE SET s.created_at=$now, s.title=$title "
        "SET s.updated_at=$now "
        "MERGE (u)-[:HAS_SESSION]->(s) "
        "CREATE (m:Message {id:$mid, user_id:$uid, session_id:$sid, role:$role, content:$content, created_at:$now, evidence_json:$evidence, explanation:$explanation}) "
        "CREATE (s)-[:CONTAINS_MESSAGE]->(m)",
        {
            "uid": user_id,
            "sid": session_id,
            "mid": mid,
            "role": role,
            "content": content,
            "now": now,
            "title": content[:72],
            "evidence": json.dumps(evidence or []),
            "explanation": explanation
        }
    )
    return mid

def upsert_memory(user_id, content, kind="fact", source="user", confidence=1.0, session_id=None, related_id=None):
    mid = "mem-" + hashlib.sha256((user_id + "|" + kind + "|" + content.lower().strip()).encode()).hexdigest()[:24]
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (m:Memory {id:$mid, user_id:$uid}) "
        "ON CREATE SET m.content=$content, m.kind=$kind, m.source=$source, m.confidence=$confidence, m.created_at=$now, m.status='active', m.reinforcement_count=1 "
        "ON MATCH SET m.updated_at=$now, m.confidence=CASE WHEN m.confidence < $confidence THEN $confidence ELSE m.confidence END, m.reinforcement_count=coalesce(m.reinforcement_count, 1) + 1 "
        "MERGE (u)-[:HAS_MEMORY]->(m)",
        {"uid": user_id, "mid": mid, "content": content, "kind": kind, "source": source, "confidence": confidence, "now": now}
    )
    if session_id:
        query("MATCH (m:Memory {id:$mid, user_id:$uid}), (s:Session {id:$sid, user_id:$uid}) MERGE (s)-[:RELATED_TO]->(m)", {"mid": mid, "uid": user_id, "sid": session_id})
    if related_id:
        query("MATCH (m:Memory {id:$mid, user_id:$uid}), (n {id:$nid, user_id:$uid}) MERGE (m)-[:RELATED_TO]->(n)", {"mid": mid, "uid": user_id, "nid": related_id})
    return mid

def upsert_goal(user_id, title, session_id=None, project_id=None):
    gid = "goal-" + hashlib.sha256((user_id + "|" + title.lower().strip()).encode()).hexdigest()[:20]
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (g:Goal {id:$gid, user_id:$uid}) "
        "ON CREATE SET g.title=$title, g.status='active', g.created_at=$now "
        "ON MATCH SET g.title=$title, g.updated_at=$now "
        "MERGE (u)-[:HAS_GOAL]->(g)",
        {"uid": user_id, "gid": gid, "title": title, "now": now}
    )
    if project_id:
        query("MATCH (g:Goal {id:$gid, user_id:$uid}), (p:Project {id:$pid, user_id:$uid}) MERGE (g)-[:BELONGS_TO]->(p)", {"gid": gid, "pid": project_id, "uid": user_id})
    return gid

def upsert_task(user_id, title, status="pending", goal_id=None, description="", priority="medium"):
    tid = "task-" + hashlib.sha256((user_id + "|" + title.lower().strip()).encode()).hexdigest()[:20]
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (t:Task {id:$tid, user_id:$uid}) "
        "ON CREATE SET t.title=$title, t.description=$description, t.status=$status, t.priority=$priority, t.created_at=$now "
        "ON MATCH SET t.title=$title, t.description=$description, t.status=$status, t.priority=$priority, t.updated_at=$now "
        "MERGE (u)-[:HAS_TASK]->(t)",
        {"uid": user_id, "tid": tid, "title": title, "description": description, "status": status, "priority": priority, "now": now}
    )
    if goal_id:
        query("MATCH (g:Goal {id:$gid, user_id:$uid}), (t:Task {id:$tid, user_id:$uid}) MERGE (g)-[:HAS_TASK]->(t)", {"gid": goal_id, "tid": tid, "uid": user_id})
    return tid

def upsert_project(user_id, name, description="", status="active"):
    pid = "proj-" + hashlib.sha256((user_id + "|" + name.lower().strip()).encode()).hexdigest()[:20]
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (p:Project {id:$pid, user_id:$uid}) "
        "ON CREATE SET p.name=$name, p.description=$description, p.status=$status, p.created_at=$now "
        "ON MATCH SET p.name=$name, p.status=$status, p.updated_at=$now "
        "MERGE (u)-[:WORKS_ON]->(p)",
        {"uid": user_id, "pid": pid, "name": name, "description": description, "status": status, "now": now}
    )
    return pid

def upsert_person(user_id, name, role="", email="", notes=""):
    pid = "person-" + hashlib.sha256((user_id + "|" + name.lower().strip()).encode()).hexdigest()[:20]
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (p:Person {id:$pid, user_id:$uid}) "
        "ON CREATE SET p.name=$name, p.role=$role, p.email=$email, p.notes=$notes, p.created_at=$now "
        "ON MATCH SET p.name=$name, p.role=CASE WHEN $role <> '' THEN $role ELSE p.role END, p.notes=CASE WHEN $notes <> '' THEN $notes ELSE p.notes END, p.updated_at=$now "
        "MERGE (u)-[:KNOWS]->(p)",
        {"uid": user_id, "pid": pid, "name": name, "role": role, "email": email, "notes": notes, "now": now}
    )
    return pid

def upsert_mistake(user_id, description, prevention_rule="", task_id=None, severity="medium"):
    mid = "mistake-" + hashlib.sha256((user_id + "|" + description.lower().strip()).encode()).hexdigest()[:20]
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (m:Mistake {id:$mid, user_id:$uid}) "
        "ON CREATE SET m.description=$desc, m.prevention_rule=$rule, m.severity=$severity, m.created_at=$now "
        "ON MATCH SET m.description=$desc, m.prevention_rule=$rule, m.severity=$severity, m.updated_at=$now "
        "MERGE (u)-[:MADE_MISTAKE]->(m)",
        {"uid": user_id, "mid": mid, "desc": description, "rule": prevention_rule, "severity": severity, "now": now}
    )
    if task_id:
        query(
            "MATCH (m:Mistake {id:$mid, user_id:$uid}), (t:Task {id:$tid, user_id:$uid}) "
            "MERGE (m)-[:WARNS_AGAINST]->(t)",
            {"mid": mid, "tid": task_id, "uid": user_id}
        )
    return mid

def upsert_habit(user_id, pattern, strength=1.0, context=""):
    hid = "habit-" + hashlib.sha256((user_id + "|" + pattern.lower().strip()).encode()).hexdigest()[:20]
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "MERGE (h:Habit {id:$hid, user_id:$uid}) "
        "ON CREATE SET h.pattern=$pattern, h.strength=$strength, h.context=$context, h.created_at=$now "
        "ON MATCH SET h.pattern=$pattern, h.strength=h.strength + 0.1, h.updated_at=$now "
        "MERGE (u)-[:HAS_HABIT]->(h)",
        {"uid": user_id, "hid": hid, "pattern": pattern, "strength": strength, "context": context, "now": now}
    )
    return hid

def add_task_dependency(user_id, task_id, depends_on_id):
    result = query(
        "MATCH (t1:Task {id:$tid, user_id:$uid}), (t2:Task {id:$did, user_id:$uid}) "
        "MERGE (t1)-[:DEPENDS_ON]->(t2) RETURN t1.id AS source, t2.id AS target",
        {"tid": task_id, "did": depends_on_id, "uid": user_id}
    )
    return bool(result.result_set)

def link_task_to_person(user_id, task_id, person_id):
    query(
        "MATCH (t:Task {id:$tid, user_id:$uid}), (p:Person {id:$pid, user_id:$uid}) "
        "MERGE (t)-[:ASSIGNED_TO]->(p)",
        {"tid": task_id, "pid": person_id, "uid": user_id}
    )

def link_project_to_person(user_id, project_id, person_id, role="contributor"):
    query(
        "MATCH (pr:Project {id:$pid, user_id:$uid}), (pe:Person {id:$eid, user_id:$uid}) "
        "MERGE (pe)-[r:COLLABORATES_ON]->(pr) SET r.role=$role",
        {"pid": project_id, "eid": person_id, "role": role, "uid": user_id}
    )

def supersede_memory(user_id, old_mid, new_mid, reason="superseded by updated information"):
    now = utcnow()
    query(
        "MATCH (old_m:Memory {id:$old_id, user_id:$uid}), (new_m:Memory {id:$new_id, user_id:$uid}) "
        "SET old_m.status='superseded', old_m.superseded_at=$now "
        "MERGE (new_m)-[r:SUPERSEDES]->(old_m) "
        "SET r.reason=$reason, r.created_at=$now",
        {"uid": user_id, "old_id": old_mid, "new_id": new_mid, "reason": reason, "now": now}
    )

def mark_conflict(user_id, mid_a, mid_b, reason="conflicting facts detected"):
    now = utcnow()
    query(
        "MATCH (ma:Memory {id:$ida, user_id:$uid}), (mb:Memory {id:$idb, user_id:$uid}) "
        "SET ma.status='disputed', mb.status='disputed' "
        "MERGE (ma)-[r1:CONTRADICTS]->(mb) SET r1.reason=$reason, r1.created_at=$now "
        "MERGE (mb)-[r2:CONTRADICTS]->(ma) SET r2.reason=$reason, r2.created_at=$now",
        {"uid": user_id, "ida": mid_a, "idb": mid_b, "reason": reason, "now": now}
    )

def reinforce_memory(user_id, mid, boost=0.1):
    now = utcnow()
    query(
        "MATCH (m:Memory {id:$mid, user_id:$uid}) "
        "SET m.confidence = CASE WHEN m.confidence + $boost > 1.0 THEN 1.0 ELSE m.confidence + $boost END, "
        "    m.last_reinforced_at = $now, "
        "    m.reinforcement_count = coalesce(m.reinforcement_count, 1) + 1",
        {"uid": user_id, "mid": mid, "boost": boost, "now": now}
    )

def retrieve(user_id, question, limit=12):
    # Keyword score supplements the anchor traversal; every returned path comes from actual FalkorDB matches.
    terms = [w.lower() for w in question.split() if len(w) > 3][:8]
    # Planning questions need the whole active goal/task neighborhood, even if the user asks vaguely.
    if any(phrase in question.lower() for phrase in ("what should", "what do i", "what next", "work on next", "recommend", "plan my")):
        terms = []
        
    result = query(
        "MATCH (u:User {id:$uid})-[:HAS_GOAL]->(g:Goal)-[:HAS_TASK]->(t:Task) "
        "OPTIONAL MATCH (t)-[:RELATED_TO|DEPENDS_ON*0..2]-(connected) WHERE connected.user_id=$uid "
        "WITH u, g, t, collect(DISTINCT connected) AS linked "
        "RETURN u, g, t, linked LIMIT $lim",
        {"uid": user_id, "lim": limit}
    )
    out = []
    seen = set()
    for row in rows(result):
        g = node_props(row.get("g"))
        t = node_props(row.get("t"))
        text = (g.get("title", "") + " " + t.get("title", "") + " " + t.get("description", "")).lower()
        linked = [node_props(x) for x in (row.get("linked") or [])]
        score = sum(1 for term in terms if term in text)
        if score or not terms:
            for n in [g, t] + linked:
                nid = n.get("id")
                if nid and nid not in seen:
                    seen.add(nid)
                    kind = (
                        "memory" if nid.startswith("mem-")
                        else "goal" if nid.startswith("goal-")
                        else "task" if nid.startswith("task-")
                        else "project" if nid.startswith("proj-")
                        else "person" if nid.startswith("person-")
                        else "mistake" if nid.startswith("mistake-")
                        else "habit" if nid.startswith("habit-")
                        else "related"
                    )
                    path = (["User", "HAS_GOAL", "Goal"] if kind == "goal" else ["User", "HAS_GOAL", "Goal", "HAS_TASK", "Task"])
                    if kind == "memory":
                        path = path + ["RELATED_TO", "Memory"]
                    elif kind == "mistake":
                        path = path + ["WARNS_AGAINST", "Mistake"]
                    elif kind == "related":
                        path = path + ["RELATED_TO", "Related node"]
                    else:
                        path = path + ["RELATED_TO", kind.capitalize()]
                        
                    out.append({
                        "id": nid,
                        "type": kind,
                        "content": n.get("content") or n.get("title") or n.get("description") or n.get("name") or n.get("pattern") or "",
                        "title": n.get("title") or n.get("name"),
                        "status": n.get("status"),
                        "confidence": n.get("confidence"),
                        "source": n.get("source"),
                        "score": score + 1,
                        "path": path
                    })
                    
    # Tasks also belong directly to a user, even when no goal has been linked yet.
    # Include them so chat and planning work with ordinary task-only messages too.
    task_result = query(
        "MATCH (u:User {id:$uid})-[:HAS_TASK]->(t:Task {user_id:$uid}) "
        "RETURN t ORDER BY t.updated_at DESC LIMIT $lim",
        {"uid": user_id, "lim": limit}
    )
    for row in rows(task_result):
        task = node_props(row.get("t"))
        task_id = task.get("id")
        title = task.get("title") or ""
        score = sum(1 for term in terms if term in title.lower())
        if task_id and task_id not in seen and (score or not terms):
            seen.add(task_id)
            out.append({
                "id": task_id,
                "type": "task",
                "content": title or task.get("description") or "",
                "title": title,
                "status": task.get("status"),
                "confidence": None,
                "source": None,
                "score": score + 1,
                "path": ["User", "HAS_TASK", "Task"]
            })

    # Also retrieve explicitly linked memories from matching goal/task neighborhood.
    mr = query(
        "MATCH (u:User {id:$uid})-[:HAS_GOAL]->(g:Goal)-[:HAS_TASK]->(t:Task)-[:RELATED_TO*0..2]-(m:Memory {user_id:$uid}) "
        "WHERE m.status <> 'superseded' "
        "RETURN DISTINCT m, g, t LIMIT $lim",
        {"uid": user_id, "lim": limit}
    )
    for row in rows(mr):
        m = node_props(row.get("m"))
        txt = m.get("content", "").lower()
        score = sum(1 for term in terms if term in txt)
        if score or not terms:
            if m.get("id") not in seen:
                seen.add(m.get("id"))
                out.append({
                    "id": m.get("id"),
                    "type": "memory",
                    "content": m.get("content"),
                    "confidence": m.get("confidence"),
                    "source": m.get("source"),
                    "score": score + 1,
                    "path": ["User", "HAS_GOAL", "Goal", "HAS_TASK", "Task", "RELATED_TO", "Memory"]
                })
                
    # Proactively check for mistakes warning against tasks in this neighborhood
    mistakes_query = query(
        "MATCH (u:User {id:$uid})-[:MADE_MISTAKE]->(mk:Mistake) "
        "OPTIONAL MATCH (mk)-[:WARNS_AGAINST]->(t:Task) "
        "RETURN mk, t LIMIT 5",
        {"uid": user_id}
    )
    for row in rows(mistakes_query):
        mk = node_props(row.get("mk"))
        t = node_props(row.get("t"))
        if mk.get("id") and mk.get("id") not in seen:
            desc = mk.get("description", "").lower()
            rule = mk.get("prevention_rule", "").lower()
            m_score = sum(1 for term in terms if term in desc or term in rule)
            if m_score or not terms:
                seen.add(mk.get("id"))
                path = ["User", "MADE_MISTAKE", "Mistake"]
                if t.get("id"):
                    path += ["WARNS_AGAINST", "Task"]
                out.append({
                    "id": mk.get("id"),
                    "type": "mistake",
                    "content": f"Warning: {mk.get('description')}. Prevention: {mk.get('prevention_rule')}",
                    "title": f"Lesson Learned: {mk.get('description')[:40]}",
                    "status": mk.get("severity", "medium"),
                    "confidence": 1.0,
                    "source": "experience",
                    "score": m_score + 2,
                    "path": path
                })

    return sorted(out, key=lambda x: x["score"], reverse=True)[:limit]

def graph_data(user_id):
    result = query("MATCH (n {user_id:$uid}) OPTIONAL MATCH (n)-[r]->(m {user_id:$uid}) RETURN n,r,m LIMIT 500", {"uid": user_id})
    nodes = {}
    edges = []
    type_map = {
        "mem": "memory",
        "task": "task",
        "goal": "goal",
        "proj": "project",
        "person": "person",
        "mistake": "mistake",
        "habit": "habit",
        "activity": "activity",
        "session": "session",
        "msg": "message"
    }
    for row in rows(result):
        for key in ("n", "m"):
            p = node_props(row.get(key))
            nid = p.get("id")
            if nid:
                prefix = nid.split("-")[0] if "-" in nid else "user"
                node_type = type_map.get(prefix, prefix)
                nodes[nid] = {"id": nid, "type": node_type, **p}
        rel = row.get("r")
        if rel:
            a = node_props(row.get("n")).get("id")
            b = node_props(row.get("m")).get("id")
            if a and b:
                edges.append({"source": a, "target": b, "label": getattr(rel, "relation", None) or "RELATED_TO"})
    return {"nodes": list(nodes.values()), "edges": edges}

def list_sessions(user_id):
    return rows(query("MATCH (u:User {id:$uid})-[:HAS_SESSION]->(s:Session) RETURN s ORDER BY s.updated_at DESC", {"uid": user_id}))

def messages(user_id, sid):
    return rows(query("MATCH (s:Session {id:$sid, user_id:$uid})-[:CONTAINS_MESSAGE]->(m:Message) RETURN m ORDER BY m.created_at", {"uid": user_id, "sid": sid}))

def memories(user_id):
    return rows(query("MATCH (u:User {id:$uid})-[:HAS_MEMORY]->(m:Memory) RETURN m ORDER BY m.created_at DESC LIMIT 200", {"uid": user_id}))

def goals(user_id):
    return rows(query("MATCH (u:User {id:$uid})-[:HAS_GOAL]->(g:Goal) OPTIONAL MATCH (g)-[:HAS_TASK]->(t:Task {user_id:$uid}) RETURN g, collect(t) AS tasks", {"uid": user_id}))

def projects(user_id):
    return rows(query("MATCH (u:User {id:$uid})-[:WORKS_ON]->(p:Project) RETURN p ORDER BY p.created_at DESC", {"uid": user_id}))

def people(user_id):
    return rows(query("MATCH (u:User {id:$uid})-[:KNOWS]->(p:Person) RETURN p ORDER BY p.created_at DESC", {"uid": user_id}))

def mistakes(user_id):
    return rows(query("MATCH (u:User {id:$uid})-[:MADE_MISTAKE]->(m:Mistake) RETURN m ORDER BY m.created_at DESC", {"uid": user_id}))

def habits(user_id):
    return rows(query("MATCH (u:User {id:$uid})-[:HAS_HABIT]->(h:Habit) RETURN h ORDER BY h.created_at DESC", {"uid": user_id}))

def activity(user_id):
    return rows(query("MATCH (a:Agent {user_id:$uid}) RETURN a ORDER BY a.created_at DESC LIMIT 100", {"uid": user_id}))

def log_agent(user_id, name, operation, status, memories_affected=None, detail=""):
    aid = "activity-" + uuid.uuid4().hex
    now = utcnow()
    query(
        "MERGE (u:User {id:$uid}) "
        "CREATE (a:Agent {id:$id, user_id:$uid, name:$name, operation:$op, status:$status, memories_affected_json:$affected, detail:$detail, created_at:$now}) "
        "CREATE (u)-[:RELATED_TO]->(a)",
        {
            "uid": user_id,
            "id": aid,
            "name": name,
            "op": operation,
            "status": status,
            "affected": json.dumps(memories_affected or []),
            "detail": detail,
            "now": now
        }
    )
    return aid

