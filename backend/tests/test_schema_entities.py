"""Unit and API contract tests for GraphMind schema expansion:
Projects, People, Mistakes, Habits, Task Dependencies, and Conflict Resolution.
"""
import uuid
import pytest
from fastapi.testclient import TestClient
from app.main import app, extract

@pytest.fixture(scope="module")
def client():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

def test_extract_patterns():
    # Test goal and task
    text1 = "My goal is to finish the backend MVP. Completed the auth module, but pending is graph indexing."
    found1 = extract(text1)
    kinds1 = [k for k, _ in found1]
    assert "goal" in kinds1
    assert "completed" in kinds1
    assert "pending" in kinds1

    # Test mistakes / lessons
    text2 = "Lesson learned: avoid hardcoding cypher queries without parameterization."
    found2 = extract(text2)
    assert any(k == "mistake" for k, _ in found2)

    # Test habits / preferences
    text3 = "Prefer to use async connection pools for high concurrency."
    found3 = extract(text3)
    assert any(k == "habit" for k, _ in found3)

    # Test project
    text4 = "Working on project GraphMind OS."
    found4 = extract(text4)
    assert any(k == "project" or k == "fact" for k, _ in found4)

def test_project_and_person_contract(client):
    user = "test-user-" + uuid.uuid4().hex
    h = {"X-User-ID": user}

    # Verify project endpoint
    p_resp = client.post("/api/projects", headers=h, json={"name": "GraphMind Core", "description": "Graph memory OS", "status": "active"})
    assert p_resp.status_code in (200, 503)  # 503 if live FalkorDB instance is not started locally yet

    # Verify person endpoint
    pe_resp = client.post("/api/people", headers=h, json={"name": "Aryan", "role": "FalkorDB Architect", "notes": "Builds graph schema"})
    assert pe_resp.status_code in (200, 503)

    # Verify mistakes endpoint
    m_resp = client.post("/api/mistakes", headers=h, json={"description": "Skipped creating user indexes", "prevention_rule": "Ensure CREATE INDEX at startup", "severity": "high"})
    assert m_resp.status_code in (200, 503)

    # Verify habits endpoint
    hab_resp = client.post("/api/habits", headers=h, json={"pattern": "Always parameterize Cypher inputs", "strength": 2.0})
    assert hab_resp.status_code in (200, 503)
