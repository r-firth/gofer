import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, wsUrl, type Event, type HubState } from "../api";
import { appendHubEvents, mergeHubSnapshot } from "../live-events";
import { isHeartbeat, watchSocket } from "../socket-liveness";

/** The workspace snapshot plus the live event socket that keeps it current. */
export function useHub() {
  const cache = useQueryClient();
  const received = useRef<Event[]>([]);
  const query = useQuery({
    queryKey: ["hub"],
    queryFn: async () => {
      const snapshot = await api<HubState>("/state");
      const merged = appendHubEvents(snapshot, received.current);
      received.current = [];
      return merged;
    },
    structuralSharing: (previous, next) =>
      mergeHubSnapshot(previous as HubState | undefined, next as HubState),
    // The socket carries every change; this is only a safety net for one it might miss.
    refetchInterval: 60000,
    retry: 1,
  });
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  const refresh = () => cache.invalidateQueries({ queryKey: ["hub"] });
  useEffect(() => {
    let dead = false;
    let socket: WebSocket | undefined;
    let lastSeen = 0;
    let retry: ReturnType<typeof setTimeout>;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      debounce ??= setTimeout(() => {
        debounce = undefined;
        refresh();
      }, 100);
    };
    const connect = () => {
      if (dead) return;
      clearTimeout(retry);
      const current = new WebSocket(wsUrl("/events"));
      socket = current;
      lastSeen = Date.now();
      current.onopen = () => {
        if (current !== socket) return;
        lastSeen = Date.now();
        setConnection("connected");
        refresh();
      };
      current.onmessage = (message) => {
        if (current !== socket) return;
        lastSeen = Date.now();
        if (isHeartbeat(message.data)) return;
        let event: Event;
        try {
          event = JSON.parse(message.data);
          if (
            typeof event.id !== "number" ||
            typeof event.kind !== "string" ||
            !event.payload
          )
            throw new Error("Invalid event");
        } catch {
          scheduleRefresh();
          return;
        }
        received.current.push(event);
        flush ??= setTimeout(() => {
          flush = undefined;
          cache.setQueryData<HubState>(["hub"], (previous) => {
            // The initial snapshot consumes this buffer if it isn't ready yet.
            if (!previous) return previous;
            const next = appendHubEvents(previous, received.current);
            received.current = [];
            return next;
          });
        }, 16);
        // Devices, sessions and chats are projections the server owns.
        if (!/^(message\.|tool\.|agent\.|memory\.)/.test(event.kind))
          scheduleRefresh();
      };
      current.onclose = () => {
        if (!dead && current === socket) {
          setConnection("reconnecting");
          retry = setTimeout(connect, 2500);
        }
      };
    };
    connect();
    const unwatch = watchSocket({
      socket: () => socket,
      lastSeen: () => lastSeen,
      reconnect: () => {
        const stale = socket;
        socket = undefined;
        stale?.close();
        setConnection("reconnecting");
        connect();
      },
    });
    return () => {
      dead = true;
      unwatch();
      clearTimeout(retry);
      clearTimeout(debounce);
      clearTimeout(flush);
      socket?.close();
    };
  }, []);
  return { ...query, connection, refresh };
}
