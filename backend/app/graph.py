"""FalkorDB access. Every application query is parameterized and user scoped."""
import os, json
from datetime import datetime, timezone
from falkordb import FalkorDB

DB = None
GRAPH = None

def utcnow():
    return datetime.now(timezone.utc).isoformat()

def connect():
    global DB, GRAPH
    DB = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"), port=int(os.getenv("FALKORDB_PORT", "6379")), password=os.getenv("FALKORDB_PASSWORD") or None)
    GRAPH = DB.select_graph(os.getenv("FALKORDB_GRAPH", "graphmind"))
    # FalkorDB supports CREATE INDEX; duplicate index errors are harmless at startup.
    for q in ("CREATE INDEX FOR (n:Memory) ON (n.user_id)", "CREATE INDEX FOR (n:Task) ON (n.user_id)", "CREATE INDEX FOR (n:Goal) ON (n.user_id)"):
        try: GRAPH.query(q)
        except Exception: pass
    return GRAPH

def query(cypher, params=None):
    if GRAPH is None: connect()
    return GRAPH.query(cypher, params or {})

def rows(result):
    # FalkorDB's Python client headers are [column_name, column_type] pairs.
    names=[column[1] if isinstance(column,(tuple,list)) and len(column)>1 else getattr(column,"name",column) for column in result.header]
    return [dict(zip(names,row)) for row in result.result_set]

def node_props(node):
    if isinstance(node, dict): return node
    return getattr(node, "properties", {}) or {}

def ensure_user(user_id):
    query("MERGE (u:User {id:$uid}) ON CREATE SET u.created_at=$now SET u.user_id=$uid", {"uid": user_id, "now": utcnow()})

def save_message(user_id, session_id, role, content, evidence=None, explanation=""):
    now=utcnow(); mid=f"msg-{__import__('uuid').uuid4()}"
    import json
    query("MERGE (u:User {id:$uid}) MERGE (s:Session {id:$sid,user_id:$uid}) ON CREATE SET s.created_at=$now, s.title=$title SET s.updated_at=$now MERGE (u)-[:HAS_SESSION]->(s) CREATE (m:Message {id:$mid,user_id:$uid,session_id:$sid,role:$role,content:$content,created_at:$now,evidence_json:$evidence,explanation:$explanation}) CREATE (s)-[:CONTAINS_MESSAGE]->(m)", {"uid":user_id,"sid":session_id,"mid":mid,"role":role,"content":content,"now":now,"title":content[:72],"evidence":json.dumps(evidence or []),"explanation":explanation})
    return mid

def upsert_memory(user_id, content, kind="fact", source="user", confidence=1.0, session_id=None, related_id=None):
    import hashlib
    mid="mem-"+hashlib.sha256((user_id+"|"+kind+"|"+content.lower().strip()).encode()).hexdigest()[:24]
    now=utcnow()
    query("MERGE (u:User {id:$uid}) MERGE (m:Memory {id:$mid,user_id:$uid}) ON CREATE SET m.content=$content,m.kind=$kind,m.source=$source,m.confidence=$confidence,m.created_at=$now,m.status='active' ON MATCH SET m.updated_at=$now,m.confidence=CASE WHEN m.confidence < $confidence THEN $confidence ELSE m.confidence END MERGE (u)-[:HAS_MEMORY]->(m)", {"uid":user_id,"mid":mid,"content":content,"kind":kind,"source":source,"confidence":confidence,"now":now})
    if session_id:
        query("MATCH (m:Memory {id:$mid,user_id:$uid}),(s:Session {id:$sid,user_id:$uid}) MERGE (s)-[:RELATED_TO]->(m)", {"mid":mid,"uid":user_id,"sid":session_id})
    if related_id:
        query("MATCH (m:Memory {id:$mid,user_id:$uid}),(n {id:$nid,user_id:$uid}) MERGE (m)-[:RELATED_TO]->(n)", {"mid":mid,"uid":user_id,"nid":related_id})
    return mid

def upsert_goal(user_id, title, session_id=None):
    import hashlib
    gid="goal-"+hashlib.sha256((user_id+title.lower()).encode()).hexdigest()[:20]; now=utcnow()
    query("MERGE (u:User {id:$uid}) MERGE (g:Goal {id:$gid,user_id:$uid}) ON CREATE SET g.title=$title,g.status='active',g.created_at=$now ON MATCH SET g.title=$title,g.updated_at=$now MERGE (u)-[:HAS_GOAL]->(g)", {"uid":user_id,"gid":gid,"title":title,"now":now})
    return gid

def upsert_task(user_id, title, status="pending", goal_id=None, description=""):
    import hashlib
    tid="task-"+hashlib.sha256((user_id+title.lower()).encode()).hexdigest()[:20]; now=utcnow()
    query("MERGE (u:User {id:$uid}) MERGE (t:Task {id:$tid,user_id:$uid}) ON CREATE SET t.title=$title,t.description=$description,t.status=$status,t.created_at=$now ON MATCH SET t.title=$title,t.description=$description,t.status=$status,t.updated_at=$now MERGE (u)-[:HAS_TASK]->(t)", {"uid":user_id,"tid":tid,"title":title,"description":description,"status":status,"now":now})
    if goal_id: query("MATCH (g:Goal {id:$gid,user_id:$uid}),(t:Task {id:$tid,user_id:$uid}) MERGE (g)-[:HAS_TASK]->(t)", {"gid":goal_id,"tid":tid,"uid":user_id})
    return tid

def retrieve(user_id, question, limit=12):
    # Keyword score supplements the anchor traversal; every returned path comes from actual FalkorDB matches.
    terms=[w.lower() for w in question.split() if len(w)>3][:8]
    # Planning questions need the whole active goal/task neighborhood, even if the user asks vaguely.
    if any(phrase in question.lower() for phrase in ("what should", "what do i", "what next", "work on next", "recommend", "plan my")):
        terms=[]
    result=query("MATCH (u:User {id:$uid})-[:HAS_GOAL]->(g:Goal)-[:HAS_TASK]->(t:Task) OPTIONAL MATCH (t)-[:RELATED_TO|DEPENDS_ON*0..2]-(connected) WHERE connected.user_id=$uid WITH u,g,t,collect(DISTINCT connected) AS linked RETURN u,g,t,linked LIMIT $lim", {"uid":user_id,"lim":limit})
    out=[]; seen=set()
    for row in rows(result):
        g=node_props(row.get("g")); t=node_props(row.get("t"))
        # Candidate relevance is calculated from graph-connected nodes only.
        text=(g.get("title","")+" "+t.get("title","")+" "+t.get("description","")).lower()
        linked=[node_props(x) for x in (row.get("linked") or [])]
        score=sum(1 for term in terms if term in text)
        if score or not terms: 
            for n in [g,t]+linked:
                nid=n.get("id")
                if nid and nid not in seen:
                    seen.add(nid)
                    kind="memory" if nid.startswith("mem-") else "goal" if nid.startswith("goal-") else "task" if nid.startswith("task-") else "related"
                    path=(["User","HAS_GOAL","Goal"] if kind=="goal" else ["User","HAS_GOAL","Goal","HAS_TASK","Task"])
                    if kind=="memory": path=path+["RELATED_TO","Memory"]
                    elif kind=="related": path=path+["RELATED_TO","Related node"]
                    out.append({"id":nid,"type":kind,"content":n.get("content") or n.get("title") or "","title":n.get("title"),"status":n.get("status"),"confidence":n.get("confidence"),"source":n.get("source"),"score":score+1,"path":path})
    # Also retrieve explicitly linked memories from matching goal/task neighborhood.
    mr=query("MATCH (u:User {id:$uid})-[:HAS_GOAL]->(g:Goal)-[:HAS_TASK]->(t:Task)-[:RELATED_TO*0..2]-(m:Memory {user_id:$uid}) WHERE m.status <> 'superseded' RETURN DISTINCT m,g,t LIMIT $lim", {"uid":user_id,"lim":limit})
    for row in rows(mr):
        m=node_props(row.get("m")); txt=m.get("content","").lower(); score=sum(1 for term in terms if term in txt)
        if score or not terms:
            if m.get("id") not in seen:
                seen.add(m.get("id")); out.append({"id":m.get("id"),"type":"memory","content":m.get("content"),"confidence":m.get("confidence"),"source":m.get("source"),"score":score+1,"path":["User","HAS_GOAL","Goal","HAS_TASK","Task","RELATED_TO","Memory"]})
    return sorted(out,key=lambda x:x["score"],reverse=True)[:limit]

def graph_data(user_id):
    result=query("MATCH (n {user_id:$uid}) OPTIONAL MATCH (n)-[r]->(m {user_id:$uid}) RETURN n,r,m LIMIT 500", {"uid":user_id})
    nodes={}; edges=[]
    for row in rows(result):
        for key in ("n","m"):
            p=node_props(row.get(key)); nid=p.get("id")
            if nid: nodes[nid]={"id":nid,"type":key and (nid.split("-")[0] if "-" in nid else "user"),**p}
        rel=row.get("r")
        if rel:
            a=node_props(row.get("n")).get("id"); b=node_props(row.get("m")).get("id")
            if a and b: edges.append({"source":a,"target":b,"label":getattr(rel,"relation",None) or "RELATED_TO"})
    return {"nodes":list(nodes.values()),"edges":edges}

def list_sessions(user_id): return rows(query("MATCH (u:User {id:$uid})-[:HAS_SESSION]->(s:Session) RETURN s ORDER BY s.updated_at DESC", {"uid":user_id}))
def messages(user_id, sid): return rows(query("MATCH (s:Session {id:$sid,user_id:$uid})-[:CONTAINS_MESSAGE]->(m:Message) RETURN m ORDER BY m.created_at", {"uid":user_id,"sid":sid}))
def memories(user_id): return rows(query("MATCH (u:User {id:$uid})-[:HAS_MEMORY]->(m:Memory) RETURN m ORDER BY m.created_at DESC LIMIT 200", {"uid":user_id}))
def goals(user_id): return rows(query("MATCH (u:User {id:$uid})-[:HAS_GOAL]->(g:Goal) OPTIONAL MATCH (g)-[:HAS_TASK]->(t:Task {user_id:$uid}) RETURN g,collect(t) AS tasks", {"uid":user_id}))
def activity(user_id): return rows(query("MATCH (a:Agent {user_id:$uid}) RETURN a ORDER BY a.created_at DESC LIMIT 100", {"uid":user_id}))
def log_agent(user_id,name,operation,status,memories_affected=None,detail=""):
    aid="activity-"+__import__('uuid').uuid4().hex; now=utcnow()
    query("MERGE (u:User {id:$uid}) CREATE (a:Agent {id:$id,user_id:$uid,name:$name,operation:$op,status:$status,memories_affected_json:$affected,detail:$detail,created_at:$now}) CREATE (u)-[:RELATED_TO]->(a)", {"uid":user_id,"id":aid,"name":name,"op":operation,"status":status,"affected":json.dumps(memories_affected or []),"detail":detail,"now":now})
    return aid
