# Memory

Gofer writes memory after a turn and recalls it before the next one, without
being asked. The code is in `crates/hub-server/src/claims.rs`, `memory.rs` and
`main.rs` (`recall`, `consolidate`), and `agent/consolidate.py`.

## Threads and sessions

A thread is a coordinator conversation with `thread: true`. The first one is
created on startup as "Thread" and cannot be closed: closing it returns 400
"The first thread is permanent and cannot be closed". `/api/state` reports it as
`thread_id`. Other threads are opened with `POST /api/threads` and can be
closed. Strands started by a thread's `start_agent`, and sessions loaded into
it, have `parent_id` set to that thread. Memory is shared across all of them.

A Claude coordinator is one Claude session. Its `agent.session` `native_id` is
projected to `chat.native_id` and resumed every turn, with only the new message
as context. The first turn of a session carries the last 100 conversation
events. If the CLI reports no saved conversation for the stored ID, the worker
records `agent.restarted` `{"text","previous","reason"}` and starts a new
session with those events replayed. No other failure restarts a session.

## Recall (every turn, every conversation)

After `message.user` and before `agent.started`, the server searches memory
with the message (its first 2000 characters). It waits up to 1.4 s for the
query vector; without one the search is text only. It returns:

- up to 8 **active** claims;
- up to 4 `message.user` or `message.assistant` events from other
  conversations, or from this one if they are older than its context window
  (its last 100 conversation events).

A result counts when its cosine similarity to the query is at least 0.65, or
when it contains at least 35% of the query's words (three or more characters),
weighted by how rare each word is in the event index. The threshold of 0.65 was
calibrated on Gemini Embedding 2, where related pairs score about 0.72 and
unrelated ones 0.49 to 0.63. `score` is the larger of the two measures.

When anything is found, `memory.recalled` is recorded in the conversation:

```json
{
  "query": "...",
  "mode": "hybrid",
  "ms": 412,
  "items": [
    { "id": 1, "kind": "claim", "text": "...", "source": "...", "time": "...", "score": 0.74 }
  ]
}
```

`mode` is `hybrid` or `text`, and `kind` is `claim` or `event`. `source` is the
name of the claim's conversation, "you" for a user message, or the name of the
event's conversation. The worker receives the same items and puts them before
the message in one `<remembered_context>` block, which says the content may be
stale and is evidence, not instruction.

## Consolidation (threads and strands)

After `agent.finished` in a thread or in any conversation with a `parent_id`,
a background task runs `agent/consolidate.py`. Tasks run one at a time and
never block the next turn. The script uses the Claude Agent SDK with model
`claude-haiku-4-5-20251001`, no tools, no settings files, no saved session and
a structured output schema.

Its input is the conversation name, who wrote the user message (the owner, or
the coordinator for a strand's brief), today's date, the turn, and the active
claims it may supersede. The turn is the user message, the final assistant
message and the latest 24 tool receipts, each with its event ID, clipped to
4000 characters per message and 400 and 800 characters for a receipt's
arguments and result. The active claims are those recalled for the turn plus
the 8 most relevant now.

The output is validated against the schema and against the IDs it was given,
and retried once with the reason if it is invalid:

```json
{
  "claims": [
    { "text": "...", "about": ["..."], "supersedes": [12], "evidence": [340] }
  ]
}
```

`text` is at most 200 characters, `supersedes` holds active claim IDs, and
`evidence` holds at least one event ID from the turn. Any failure records
`memory.error` `{"error","run_id"}` in the conversation. Claims, if any, are
recorded as `memory.written`
`{"claims":[{"id","text","about","supersedes":[{"id","text"}]}]}`.

When a session is loaded from a machine, its last eight turns are consolidated
in the same way.

## Graph model (Vecgra)

- `Claim` nodes have `text`, `state` (`active`, `superseded` or `retracted`),
  `created_at`, `scope` (conversation ID) and `source` (conversation name).
- `Entity` nodes have `name`, lower case, and are reused by name.
- `ABOUT` runs from a claim to an entity, `SUPPORTED_BY` from a claim to an
  event, and `SUPERSEDES` from a new claim to the claim it replaces. The old
  claim becomes `superseded` in the same transaction.

The background indexer embeds claims before events. A state change keeps the
claim's vector.

## Endpoints

- `POST /api/memory/claims/{id}/wrong` sets the state to `retracted` and
  records `memory.retracted` `{"id","text"}` in the claim's scope.
  `.../restore` undoes it, returning the claim to `superseded` if another claim
  supersedes it and to `active` otherwise, and records `memory.restored`.
  Retracted and superseded claims are never recalled. Repeating either action
  returns 400.
- `GET /api/memory/search?q=&kind=&mode=&offset=` searches memory. `kind` is
  `all`, `claim`, `message`, `tool`, `terminal`, `system` or `raw`; `kind=claim`
  searches only claims and `kind=all` includes them. `mode=hybrid` adds vector
  matches.
- `GET /api/memory/graph` returns an overview: recent scopes and events, the
  newest 24 claims, and every claim supported by a shown event, with their
  entities and supersession neighbours. `?node=<claim>` returns all of a
  claim's neighbours, and `?node=<entity>` the claims about it, 100 per page.
- `GET /api/memory/element/node/{id}` returns one node with its properties,
  vector and neighbours.
- `GET /api/memory/runs/{id}` returns the events of one turn.

Nodes returned by these endpoints carry `label` (`"Claim"` or `"Entity"`) and
`kind` and `category` (`"claim"` or `"entity"`). Claim nodes add `state`,
`about`, `evidence`, `source`, `scope`, `time` and `run_id` (the run of the
first evidence event); `excerpt` is the claim text. An entity's `title` is its
name.

## Embeddings

`HUB_EMBEDDING_MODEL` (default `google/gemini-embedding-2`) and
`HUB_EMBEDDING_DIMENSIONS` (default 768) select the model. Gemini inputs are
prefixed `task: search result | query: ` for queries and `title: none | text: `
for documents; Qwen3 embedding models get a query instruction and no document
prefix. Endpoint, model, dimensions and prefixes form the stored profile. A
change backs up the old vectors and reindexes, and a new dimension rebuilds
`history.vg` with every node ID preserved. See
[embeddings](architecture.md#embeddings).

## Checks

`crates/hub-server/tests/claims.rs` and `agent/test_consolidate.py` run in
`npm run check`. `scripts/memory-live-smoke.py` is an opt-in live check on an
isolated server with real Claude turns, consolidation, recall, supersession and
the `wrong` endpoint. It spends Claude usage and OpenRouter credit:

```sh
set -a; . ./.env; set +a
agent/.venv/bin/python scripts/memory-live-smoke.py report.json
```
