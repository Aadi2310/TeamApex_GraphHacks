import asyncio

from fastapi.testclient import TestClient

from app.main import app, errors


def test_api_rejects_blank_values_and_unknown_fields():
    with TestClient(app, raise_server_exceptions=False) as client:
        blank_chat = client.post("/api/chat", json={"message": "   "})
        blank_task = client.post("/api/tasks", json={"title": "   "})
        unknown = client.post("/api/tasks", json={"title": "Prepare launch", "unexpected": True})

    assert blank_chat.status_code == 422
    assert blank_task.status_code == 422
    assert unknown.status_code == 422


def test_session_id_is_bounded_and_restricted():
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/api/chat", json={"message": "hello", "session_id": "../other-user"})

    assert response.status_code == 422


def test_invalid_user_header_is_rejected_before_database_access():
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/sessions", headers={"X-User-ID": "invalid user id"})

    assert response.status_code == 400


def test_self_dependency_is_rejected_without_database_access():
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/api/tasks/task-1/dependency", json={"depends_on_task_id": "task-1"})

    assert response.status_code == 400


def test_unexpected_exception_response_does_not_expose_exception_text():
    response = asyncio.run(errors(None, RuntimeError("private database details")))

    assert response.status_code == 500
    assert b"private database details" not in response.body
