import type { Event, HubState } from "./api";

/** Apply persisted events directly; the socket is already the live data feed. */
export function appendHubEvents(state: HubState, incoming: Event[]): HubState {
  const known = new Set(state.events.map((event) => event.id));
  const added = incoming.filter((event) => {
    if (known.has(event.id)) return false;
    known.add(event.id);
    return true;
  });
  if (!added.length) return state;
  const running = new Set(state.running);
  for (const event of added) {
    if (event.kind === "agent.started") running.add(event.scope);
    if (["agent.finished", "agent.stopped", "agent.error"].includes(event.kind))
      running.delete(event.scope);
  }
  return {
    ...state,
    events: [...state.events, ...added].sort((a, b) => a.id - b.id),
    running: [...running],
    event_count: state.event_count + added.length,
  };
}

/** A snapshot may have been captured before the most recent socket messages. */
export function mergeHubSnapshot(
  previous: HubState | undefined,
  next: HubState,
): HubState {
  if (!previous) return next;
  const last = next.events.at(-1)?.id || 0;
  const merged = appendHubEvents(
    next,
    previous.events.filter((event) => event.id > last),
  );
  return {
    ...merged,
    event_count: Math.max(previous.event_count, merged.event_count),
  };
}
