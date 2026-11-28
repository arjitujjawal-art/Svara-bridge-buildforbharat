export type Role = "patient" | "desk";
export type Slot = { date: string; time: string; timezone: "Asia/Kolkata" };
export type Appointment = {
  offer_id: string;
  slot: Slot;
  status: "open" | "declined" | "countered" | "accepted" | "confirmed";
};
export type Decision = {
  turn_id: string;
  revision: number;
  approved_text: string;
  voice_render?: string;
  intent: "message" | "decline" | "counter" | "accept";
  offer_id?: string;
  requested_slot?: Slot;
};
type PatientMessage = {
  type: "patient.message"; seq: number; sender: "patient"; message_id: string;
  decision: Decision; appointment: Appointment | null;
};
type DeskOffer = {
  type: "desk.offer"; seq: number; sender: "desk"; message_id: string; appointment: Appointment;
};
export type Message = PatientMessage | DeskOffer;
type ReceiptStatus = "delivered" | "played" | "failed";
export type History = {
  event: Message; delivered: boolean; playback: Exclude<ReceiptStatus, "delivered"> | null;
};
type Snapshot = {
  type: "room.snapshot"; seq: number; desk_connected: boolean; ended: boolean;
  appointment: Appointment | null; history: History[];
};
type RelayEvent = Snapshot | Message
  | { type: "desk.joined"; seq: number }
  | { type: "room.ended"; seq: number }
  | { type: "desk.confirmed"; seq: number; appointment: Appointment }
  | { type: "peer.receipt"; seq: number; message_id: string; delivered: boolean; playback: History["playback"] };
type Reply =
  | { type: "command.ack"; event_id: string }
  | { type: "command.error"; event_id?: string; detail: string }
  | { type: "connection.error"; detail: string };
type Command =
  | { type: "desk.offer"; slot: Slot }
  | { type: "desk.confirm"; offer_id: string }
  | ({ type: "patient.commit" } & Decision)
  | { type: "peer.receipt"; message_id: string; status: ReceiptStatus }
  | { type: "room.end" };

export type Credentials = { room_id: string; token: string; invite?: string };
export type RoomState = Pick<Snapshot, "appointment" | "desk_connected" | "ended" | "history">;
export const emptyRoom: RoomState = { appointment: null, desk_connected: false, ended: false, history: [] };

export function reduceRoom(state: RoomState, event: RelayEvent): RoomState {
  switch (event.type) {
    case "room.snapshot":
      return event;
    case "desk.joined":
      return { ...state, desk_connected: true };
    case "desk.confirmed":
      return { ...state, appointment: event.appointment };
    case "patient.message":
    case "desk.offer":
      return {
        ...state, appointment: event.appointment,
        history: [...state.history, { event, delivered: false, playback: null }].slice(-64),
      };
    case "peer.receipt":
      return {
        ...state,
        history: state.history.map(item => item.event.message_id === event.message_id
          ? { ...item, delivered: event.delivered, playback: event.playback }
          : item),
      };
    case "room.ended":
      return { ...emptyRoom, ended: true };
  }
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function api(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init);
  if (response.ok) return response;
  const body = await response.json().catch(() => null);
  throw new ApiError(body?.code ?? "request_failed", typeof body?.detail === "string" ? body.detail : `Request failed (${response.status}).`);
}

export function createRoom(): Promise<Credentials> {
  return api("/api/rooms", { method: "POST" }).then(response => response.json());
}

export function joinRoom(room_id: string, invite: string): Promise<Credentials> {
  return api("/api/rooms/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room_id, invite }),
  }).then(response => response.json());
}

export class Relay {
  private socket: WebSocket;
  private ready = false;
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: number }>();

  constructor(
    credentials: Credentials,
    onEvent: (event: RelayEvent) => void,
    onStatus: (ready: boolean, detail: string) => void,
  ) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.host}/api/relay`);
    this.socket.onopen = () => this.socket.send(JSON.stringify({
      room_id: credentials.room_id, token: credentials.token,
    }));
    let closeDetail = "Connection lost. Reconnect and review before sending.";
    this.socket.onmessage = message => {
      const event: RelayEvent | Reply = JSON.parse(message.data);
      if (event.type === "connection.error") {
        closeDetail = event.detail;
        return;
      }
      if (event.type === "command.ack" || event.type === "command.error") {
        const pending = this.pending.get(event.event_id ?? "");
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(event.event_id!);
          if (event.type === "command.ack") pending.resolve();
          else pending.reject(new Error(event.detail));
        } else if (!event.event_id && event.type === "command.error") {
          onStatus(this.ready, event.detail);
        }
        return;
      }
      onEvent(event);
      if (event.type === "room.snapshot" && !event.ended) {
        this.ready = true;
        onStatus(true, "Connected.");
      }
      if (event.type === "room.ended" || event.type === "room.snapshot" && event.ended) {
        closeDetail = "Call ended.";
        this.close();
      }
    };
    this.socket.onclose = () => {
      this.ready = false;
      this.rejectPending(closeDetail);
      onStatus(false, closeDetail);
    };
  }

  send(command: Command, event_id: string = crypto.randomUUID()): Promise<void> {
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Reconnect before sending."));
    }
    if (this.pending.has(event_id)) {
      return Promise.reject(new Error("Waiting for the room to acknowledge this action."));
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(event_id);
        reject(new Error("No acknowledgement yet. Review the room and retry if needed."));
      }, 5000);
      this.pending.set(event_id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ ...command, event_id }));
    });
  }

  close() {
    this.ready = false;
    this.socket.close();
  }

  private rejectPending(detail: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(detail));
    }
    this.pending.clear();
  }
}
