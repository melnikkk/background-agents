# Background Agents

An incident-response agent that keeps working after the prompt ends. A separate checkout service provides a changing world to observe and a small operations API to act on. An operator app shows the inbox, incidents, and event history.

## System boundary

```text
checkout process (port 3004) ── alert ──> operator API (port 3001)
checkout process <── fresh HTTP observation / operation ── incident agent (port 3002)
operator inbox ── human decision ──> paused Inngest run
```

The checkout process owns its state in memory. Each start creates a new service instance with a fresh state. It sends a stable event ID until the operator API acknowledges it. The operator API persists events in Neon and opens **one run for an active incident**. Later alerts for that service instance join and wake the run. An event is a notification; the agent reads current checkout state over HTTP before deciding. An action changes checkout state, which the next observation must verify. On a service restart, an unfinished run is superseded because its old observations and approvals belong to a different instance.

The default goal and `health.status = healthy` completion condition are set in `server/environment.ts`. Set `AGENT_GOAL` on the operator process to override the goal before a new incident opens. The checkout service owns the effects and remembers action IDs so a retry does not repeat a committed effect.

## Setup

Requires Node.js 22+, npm, an internet connection, and an LLM API key. No local PostgreSQL, deployment, or Inngest Cloud account is needed.

```bash
npm install
cp .env.example .env
```

Get a temporary PostgreSQL connection string from [neon.new](https://neon.new/) and put it in `.env` with your model credentials:

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DB?sslmode=require"
GOOGLE_GENERATIVE_AI_API_KEY=your-key
```

```bash
npm run db:push
npm run preflight
npm run db:seed
```

Keep these running in three terminals:

| Terminal | Command                | What stays up                                      |
| -------- | ---------------------- | -------------------------------------------------- |
| 1        | `npm run dev:agent`    | Agent endpoint                                     |
| 2        | `npm run dev`          | Operator API, dashboard, and Inngest Dev Server    |
| 3        | `npm run dev:checkout` | Healthy checkout service; restart to change faults |

The operator app is at http://127.0.0.1:5173 and Inngest traces are at http://127.0.0.1:8288. `npm run stop` ends all services started from this repository (macOS/Linux).

| Process            | Command                                   | Address        |
| ------------------ | ----------------------------------------- | -------------- |
| Checkout service   | `npm run dev:checkout -- --fault feature` | 127.0.0.1:3004 |
| Operator API       | `npm run dev:operator`                    | 127.0.0.1:3001 |
| Agent endpoint     | `npm run dev:agent`                       | 127.0.0.1:3002 |
| Operator UI        | `npm run dev:web`                         | 127.0.0.1:5173 |
| Inngest Dev Server | `npm run dev:inngest`                     | 127.0.0.1:8288 |

## Fault injection

Stop terminal 3 and restart it with one of:

```bash
npm run dev:checkout -- --fault feature --alerts 3 --interval-ms 1000
npm run dev:checkout -- --fault release
npm run dev:checkout -- --fault dependency --recover-after-ms 30000
npm run dev:checkout -- --fault feature --lose-next-action-response
npm run dev:checkout -- --fault none
```

Run one checkout process at a time. `--fault` accepts `none`, `feature`, `release`, or `dependency`; each start resets state and creates a new instance. `--alerts` sets how many alert events to emit and `--interval-ms` their spacing. `--recover-after-ms 0` leaves a dependency degraded until restart. `--lose-next-action-response` commits the first mutating operation and replies 503 once.

The UI has three routes: `/` for human requests, `/activity` for incident runs and their saved activity, and `/events` for service events and current checkout state.

## Tooling

Oxfmt (single quotes, no semicolons), Oxlint, and TypeScript: `npm run format`, `npm run lint`, `npm run typecheck`.
