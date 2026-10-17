# GraphMind OS

GraphMind is a small, working multi-agent memory MVP. FastAPI stores messages, memories, goals, tasks, and agent events as connected FalkorDB nodes. The Planner reads the active goal and its connected task statuses from FalkorDB to recommend the next open task. The chat UI displays the retrieved records and graph paths that informed each answer.

## Run locally

1. Install Docker Desktop and start it.
2. Copy `.env.example` to `.env`. The defaults use FalkorDB on the Compose network and deterministic local answers, so no paid API key is needed.
3. Run `docker compose up --build`.
4. Open the UI at [http://localhost:3001](http://localhost:3001), API docs at [http://localhost:8000/docs](http://localhost:8000/docs), and FalkorDB Browser at [http://localhost:3000](http://localhost:3000).

FalkorDB persists data in the `falkordb_data` Docker volume. Check connectivity at `GET /api/health`. Set `LLM_PROVIDER=openai`, `LLM_API_KEY`, and optionally `LLM_MODEL` to enable the OpenAI-compatible chat completion path. The deterministic mode still writes and reads actual FalkorDB records; it is not a memory mock. `X-User-ID` selects a workspace (the UI currently uses `demo-user`).

## Demo scenario

In Chat, send:

> I'm building GraphMind OS for a hackathon. My goal is to finish the MVP by Sunday. I have completed the chat interface, but the graph retrieval is still pending.

The Memory Agent stores a user message, an active Sunday goal, one completed task, one pending task, and linked memory records. Start a new conversation (or refresh the page) and ask “What should I work on next for my hackathon project?” The Planner queries the graph-connected active goal and task nodes, recommends graph retrieval, and returns evidence with the `User → Goal → Task → RELATED_TO → Memory` path. Mark a task complete in Goals & Tasks, then ask again to see the shared state change the recommendation. Agent Activity includes an explicit Reflection run that reports possible conflicts without deleting history.

## Architecture and graph schema

* `frontend/` — Next.js, React, TypeScript, and Tailwind CSS. The relationship map is rendered with SVG from live API graph results; no sample graph is hardcoded.
* `backend/app/main.py` — validated FastAPI API, deterministic extraction, orchestration, and optional provider adapter.
* `backend/app/graph.py` — FalkorDB connection and all application-controlled, parameterized Cypher.
* `docker-compose.yml` — FalkorDB with persistent storage, API, and UI.

Node labels: `User`, `Session`, `Message`, `Memory`, `Goal`, `Task`, `Agent`. Memory IDs and goal/task IDs are stable hashes; messages and agent events use unique IDs. Properties include user ID, timestamps, source, confidence, task status, and content. The app uses `HAS_SESSION`, `CONTAINS_MESSAGE`, `HAS_MEMORY`, `RELATED_TO`, `HAS_GOAL`, and `HAS_TASK`. Indexes are requested for `Memory.user_id`, `Task.user_id`, and `Goal.user_id` at connection time.

### Important Cypher patterns

Create/merge user-scoped memories:

```cypher
MERGE (u:User {id:$uid})
MERGE (m:Memory {id:$mid,user_id:$uid})
ON CREATE SET m.content=$content,m.kind=$kind,m.source=$source,
  m.confidence=$confidence,m.created_at=$now,m.status='active'
MERGE (u)-[:HAS_MEMORY]->(m)
```

Planner context starts with the current user and traverses their active goal to connected tasks, then follows up to two relationship hops to related graph nodes. A second query follows task-to-memory links. Both queries constrain every traversed node to the same user. This is why a task update changes the recommendation: the Planner reads persisted connected task status rather than replaying the original chat or consulting process-local state.

## API

All endpoints use the optional `X-User-ID` header (`demo-user` by default). API explorer: `/docs`.

* `POST /api/chat` — save message, extract structured memory, traverse graph, and answer.
* `GET /api/sessions` and `GET /api/sessions/{session_id}/messages` — scoped conversation history.
* `GET /api/memories`, `GET /api/graph`, `GET /api/goals` — scoped graph views.
* `POST /api/tasks`, `PATCH /api/tasks/{task_id}` — create/update task state.
* `POST /api/agents/reflect`, `GET /api/agents/activity` — reflection and agent event log.
* `GET /api/health` — FalkorDB connectivity check.

## Security and limitations

No credentials are committed; `.env.example` contains placeholders. LLMs do not execute Cypher. User IDs are validated and every API graph query is scoped by user ID. Reflection reports candidate conflicts for human review and preserves history. The included extractor is deterministic and deliberately small: it recognizes common goal and task status phrases, not arbitrary natural language. The UI currently selects the `demo-user` workspace; production deployments should add authentication and derive the user ID from verified identity rather than trusting a request header. Task dependencies and decision nodes are part of the intended schema but are not yet authored by the MVP UI. LLM integration currently supports deterministic mode and OpenAI chat completions.

## Verification and demo recording

Run the checks from a clean checkout:

```sh
docker compose up --build -d
curl http://localhost:8000/api/health
```

Then follow the demo scenario and confirm node/edge changes in the FalkorDB Browser. Automated integration tests are in `backend/tests`; run them after starting FalkorDB with `pip install -r backend/requirements.txt pytest` and `pytest backend/tests`.

For a short demo video, record the first prompt, the answer’s “Why this answer?” evidence, a refresh/new conversation, the Planner recommendation, a task status update, and the changed recommendation. The project was created with AI coding assistance; the human team should review and understand the code and technical decisions before submission.
