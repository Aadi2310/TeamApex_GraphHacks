# GraphMind OS

GraphMind OS is a graph-backed memory workspace for AI agents. It stores conversations, goals, tasks, projects, lessons, habits, and agent activity in FalkorDB so the Planner can retrieve connected context and recommend the next open task.

The frontend uses a dark, Qronos-inspired dashboard theme. It includes Chat, Memory Graph, Goals & Tasks, and Agent Activity views; animated page transitions; a responsive sidebar; recent conversation history; and a top-to-bottom graph view with optional secondary links.

## Features

- Persistent, user-scoped graph memory powered by FalkorDB.
- Chat sessions that can be reopened from **Recent** and continue across refreshes.
- Deterministic local memory extraction for goals, task status, mistakes, habits, and project mentions.
- Graph-aware Planner recommendations based on active goals, task status, dependencies, and related lessons.
- A readable, vertically arranged memory graph with a toggle for additional relationships.
- Workspace views for goals and tasks and agent activity; API support for projects, people, mistakes, and habits.
- Optional OpenAI chat completions; deterministic mode works without an API key.

## Run with Docker Compose

You need Docker Desktop with the Linux container engine running.

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

Open the app and service pages:

- Frontend: [http://localhost:3001](http://localhost:3001)
- API documentation: [http://localhost:8000/docs](http://localhost:8000/docs)
- FalkorDB Browser: [http://localhost:3000](http://localhost:3000)

Check that the API can reach FalkorDB at [http://localhost:8000/api/health](http://localhost:8000/api/health). Stop the services with `docker compose down`. Graph data is stored in the `falkordb_data` volume and remains when containers stop; `docker compose down -v` also removes that data.

## Configuration

The defaults in `.env.example` run locally with deterministic responses and do not require a paid API key.

| Variable | Purpose | Default |
| --- | --- | --- |
| `FALKORDB_HOST` | FalkorDB host inside Compose | `falkordb` |
| `FALKORDB_PORT` | FalkorDB port | `6379` |
| `FALKORDB_USERNAME` | Optional database username | empty |
| `FALKORDB_PASSWORD` | Optional database password | empty |
| `FALKORDB_GRAPH` | Graph name | `graphmind` |
| `LLM_PROVIDER` | `deterministic` or `openai` | `deterministic` |
| `LLM_API_KEY` | Provider API key when using OpenAI | empty |
| `LLM_MODEL` | Optional OpenAI chat model override | `gpt-4o-mini` |
| `USER_ID` | Default API workspace when header is omitted | `demo-user` |

To enable OpenAI responses, set `LLM_PROVIDER=openai` and `LLM_API_KEY` in `.env`, then restart with `docker compose up --build -d`. The API accepts an optional `X-User-ID` header to select a workspace; the frontend currently uses `demo-user`.

## Demo

In Chat, send:

> I'm building GraphMind OS for a hackathon. My goal is to finish the MVP by Sunday. I have completed the chat interface, but the graph retrieval is still pending.

The Memory Agent saves the conversation, goal, task statuses, and related memory. Ask “What should I work on next for my hackathon project?” to see the Planner use graph-connected tasks to recommend the next open item. Visit **Memory Graph** to follow the saved relationships, or **Goals & Tasks** to update task status. Use **Recent** in the sidebar to reopen the conversation. **Agent Activity** includes a reflection action that flags possible conflicts and records `CONTRADICTS` links without deleting history.

## Architecture

| Path | Responsibility |
| --- | --- |
| `frontend/` | Next.js, React, and TypeScript dashboard and graph visualization |
| `frontend/components/ui/` | Page transition, chat composer, and memory graph components |
| `backend/app/main.py` | FastAPI routes, deterministic extraction, agent orchestration, and optional LLM adapter |
| `backend/app/graph.py` | FalkorDB connection, graph schema, parameterized Cypher, and user-scoped traversals |
| `docker-compose.yml` | FalkorDB, API, and frontend services with persistent graph storage |

The graph uses `User`, `Session`, `Message`, `Memory`, `Goal`, `Task`, `Agent`, `Project`, `Person`, `Mistake`, and `Habit` nodes. Relationships include:

- Workspace and memory: `HAS_SESSION`, `CONTAINS_MESSAGE`, `HAS_MEMORY`, `RELATED_TO`, `HAS_GOAL`, `HAS_TASK`
- Planning: `DEPENDS_ON`, `ASSIGNED_TO`, `WORKS_ON`, `BELONGS_TO`
- Lessons and preferences: `MADE_MISTAKE`, `WARNS_AGAINST`, `HAS_HABIT`
- Memory evolution: `SUPERSEDES`, `CONTRADICTS`

Graph traversals constrain records to the requesting user. IDs for durable memories and entities are deterministic hashes; messages and agent events use unique IDs.

## API overview

All endpoints accept the optional `X-User-ID` header (`demo-user` by default). See `/docs` for request and response schemas.

| Endpoints | Purpose |
| --- | --- |
| `POST /api/chat` | Save a message, extract supported memories, retrieve graph context, and respond |
| `GET /api/sessions`, `GET /api/sessions/{session_id}/messages` | List and load conversation history |
| `GET /api/memories`, `GET /api/graph`, `GET /api/goals` | Read scoped graph data |
| `POST /api/tasks`, `PATCH /api/tasks/{task_id}` | Create tasks and update status, priority, or details |
| `POST /api/tasks/{task_id}/dependency` | Add a task dependency |
| `GET/POST /api/projects` | Read or create projects |
| `GET/POST /api/people` | Read or create people |
| `GET/POST /api/mistakes` | Read or record lessons and prevention rules |
| `GET/POST /api/habits` | Read or create habits and preferences |
| `POST /api/agents/reflect`, `GET /api/agents/activity` | Flag possible memory conflicts and inspect agent events |
| `GET /api/health` | Check the FalkorDB connection |

## Development and verification

Build and start the containers with `docker compose up --build -d`. Follow logs with `docker compose logs -f frontend backend`, then check `GET /api/health`.

The backend integration tests are in `backend/tests`. With FalkorDB running, install the dependencies and pytest, then run:

```sh
python -m pip install -r backend/requirements.txt pytest
pytest backend/tests
```

Build the frontend directly from its directory with:

```sh
npm install
npm run build
```

## Security and limitations

Do not commit `.env`; `.env.example` contains placeholders. The deterministic extractor recognizes common phrases and is intentionally limited; it is not a general natural-language understanding system. Projects, people, mistakes, and habits can also be created through their API endpoints. The app uses a demo workspace and trusts the `X-User-ID` header, so production deployment requires authentication and deriving workspace identity from a verified user. LLM output is given retrieved graph context and the model does not execute Cypher.
