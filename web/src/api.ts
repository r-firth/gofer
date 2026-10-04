import type { ChatImage } from "./ChatImages";

export type Device = {
  id: string;
  name: string;
  target: string | null;
  status: string;
  source?: string;
  os?: string;
  address?: string | null;
  tailscale_id?: string | null;
  ssh?: string;
};
export type Session = {
  id: string;
  name: string;
  device_id: string;
  cwd: string;
  owner: "user" | "agent";
  closed: boolean;
  cleanup_pending?: boolean;
  cleanup_error?: string | null;
  created_at: string;
};
export type AgentSession = {
  provider: "codex" | "copilot" | "claude";
  device_id: string;
  cwd: string;
  native_id?: string | null;
};
export type Chat = {
  coordinator_provider?: "codex" | "claude";
  agent?: AgentSession | null;
  parent_id?: string | null;
  id: string;
  name: string;
  created_at: string;
  closed?: boolean;
  closing?: boolean;
  close_error?: string | null;
  session_ids?: string[];
  title_generated?: boolean;
  updated_at?: string;
  /** A conversation with Gofer: the first thread, or one opened for a topic. */
  thread?: boolean;
  /** A strand loaded from a session that already existed on its machine. */
  loaded?: boolean;
  /** The project a thread belongs to. */
  project_id?: string | null;
};
/** A named collection of threads. */
export type Project = {
  id: string;
  name: string;
  created_at: string;
  closed?: boolean;
};
export type Event = {
  id: number;
  kind: string;
  scope: string;
  time: string;
  payload: Record<string, any>;
};
export type HubState = {
  public_origin?: string | null;
  thread_id?: string;
  device_aliases?: Record<string, string>;
  devices: Device[];
  discovery?: {
    status: string;
    message: string;
    last_sync: string | null;
    count: number;
  };
  sessions: Session[];
  chats: Chat[];
  projects?: Project[];
  events: Event[];
  live: string[];
  running: string[];
  event_count: number;
  embedding_status: string;
  embedding_model?: string;
  embedding_dimensions?: number;
  model: string;
};
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("AUTH_REQUIRED");
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return response.json();
}
/** Store a picture to attach to a message. The server checks what it really is. */
export async function uploadImage(
  file: Blob,
  name: string,
): Promise<ChatImage> {
  const response = await fetch(
    `/api/uploads?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  if (!response.ok) {
    if (response.status === 401) throw new Error("AUTH_REQUIRED");
    if (response.status === 413) throw new Error("Images are limited to 25 MB");
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Upload failed (${response.status})`);
  }
  return response.json();
}
export const wsUrl = (path: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api${path}`;

export function randomId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
