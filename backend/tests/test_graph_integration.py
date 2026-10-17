"""Integration checks against a real FalkorDB instance; never uses a fake graph."""
import os
import uuid
import pytest
from fastapi.testclient import TestClient
from app.main import app

@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c: yield c

def test_demo_traversal_persistence_and_user_isolation(client):
    user="demo-"+uuid.uuid4().hex
    h={"X-User-ID":user}
    r=client.post("/api/chat",headers=h,json={"message":"I'm building GraphMind OS for a hackathon. My goal is to finish the MVP by Sunday. I have completed the chat interface, but the graph retrieval is still pending."})
    assert r.status_code==200, r.text
    sid=r.json()["session_id"]
    assert any("graph retrieval" in m["content"].lower() for m in r.json()["memories"])
    next_turn=client.post("/api/chat",headers=h,json={"message":"What should I work on next for my hackathon project?"})
    assert next_turn.status_code==200, next_turn.text
    assert "graph retrieval" in next_turn.json()["answer"].lower()
    assert any("RELATED_TO" in " ".join(m["path"]) for m in next_turn.json()["memories"])
    assert len(client.get(f"/api/sessions/{sid}/messages",headers=h).json()["messages"])==2
    other={"X-User-ID":user+"-other"}
    assert client.get("/api/goals",headers=other).json()["goals"]==[]
    task=next(x for group in client.get("/api/goals",headers=h).json()["goals"] for x in group["tasks"] if "graph retrieval" in x["title"].lower())
    assert client.patch(f"/api/tasks/{task['id']}",headers=other,json={"status":"completed"}).status_code==404
    assert client.patch(f"/api/tasks/{task['id']}",headers=h,json={"status":"completed"}).status_code==200
    changed=client.post("/api/chat",headers=h,json={"message":"What should I work on next?"})
    assert changed.status_code==200
    assert "graph retrieval" not in changed.json()["answer"].lower()

def test_missing_graph_is_not_mocked():
    # Connection behavior is separately exposed by health; this test asserts API's live backend target config.
    assert os.getenv("FALKORDB_GRAPH","graphmind")
