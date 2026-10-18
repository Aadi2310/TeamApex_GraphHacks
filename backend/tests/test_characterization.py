"""Characterization checks for legacy behavior kept during Phase 0."""

import uuid
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import graph
from app.main import answer_deterministic, app, extract


def test_extract_current_phrase_patterns():
    cases = [
        ("My goal is to ship the API by Friday.", "goal"),
        ("Completed the login flow.", "completed"),
        ("Graph indexing is still pending.", "pending"),
        ("Lesson learned: avoid hidden state.", "mistake"),
        ("I prefer to work in the morning.", "habit"),
        ("Working on project GraphMind OS.", "project"),
        ("I'm building a graph UI.", "fact"),
    ]

    for message, expected_kind in cases:
        assert expected_kind in [kind for kind, _ in extract(message)], message


def test_deterministic_chat_answers_conversationally_with_workspace_context():
    reply = answer_deterministic(
        "What should I tackle first?",
        [{"type": "task", "title": "Review launch pricing", "status": "pending"}],
    )

    assert "Review launch pricing" in reply
    assert "graph memory" not in reply.lower()


def test_deterministic_chat_greeting_is_not_a_graph_status_message():
    reply = answer_deterministic("Hi there!", [])

    assert reply.startswith("Hi!")
    assert "goal" in reply.lower()


def _query_result(header, result_set):
    return SimpleNamespace(
        header=[(None, name) for name in header],
        result_set=result_set,
    )


def test_retrieve_is_user_scoped_and_orders_higher_keyword_scores(monkeypatch):
    calls = []
    rows = [
        _query_result(
            ["u", "g", "t", "linked"],
            [
                (
                    {"id": "user-1"},
                    {"id": "goal-low", "title": "Deploy beta"},
                    {"id": "task-low", "title": "Write docs", "user_id": "reader-1"},
                    [],
                ),
                (
                    {"id": "user-1"},
                    {"id": "goal-high", "title": "Deploy launch"},
                    {"id": "task-high", "title": "Write docs", "user_id": "reader-1"},
                    [],
                ),
            ],
        ),
        _query_result(
            ["t"],
            [({"id": "task-orphan", "title": "Review launch pricing", "status": "pending", "user_id": "reader-1"},)],
        ),
        _query_result(["m", "g", "t"], []),
        _query_result(["mk", "t"], []),
    ]

    def fake_query(statement, params):
        calls.append((statement, params))
        return rows[len(calls) - 1]

    monkeypatch.setattr(graph, "query", fake_query)

    results = graph.retrieve("reader-1", "deploy launch review launch")

    assert results[0]["id"] == "goal-high"
    assert any(result["id"] == "task-orphan" for result in results)
    assert next(result for result in results if result["id"] == "task-orphan")["path"] == ["User", "HAS_TASK", "Task"]
    assert all(params["uid"] == "reader-1" for _, params in calls)
    assert all("$uid" in statement for statement, _ in calls)


def test_readme_scenario():
    """Run the README demo through the existing legacy API routes and a live graph."""
    user = "readme-" + uuid.uuid4().hex
    headers = {"X-User-ID": user}
    scenario = (
        "I'm building GraphMind OS for a hackathon. My goal is to finish the MVP by Sunday. "
        "I have completed the chat interface, but the graph retrieval is still pending."
    )

    with TestClient(app) as client:
        first = client.post("/api/chat", headers=headers, json={"message": scenario})
        assert first.status_code == 200, first.text
        second = client.post("/api/chat", headers=headers, json={"message": "What should I work on next for my hackathon project?"})
        assert second.status_code == 200, second.text
        assert "graph retrieval" in second.json()["answer"].lower()
