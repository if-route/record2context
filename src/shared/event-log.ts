import { videoTime, type VideoClock } from "./clock";
import type { RawEvent, RecEvent } from "./types";

export const NETWORK_CAP = 2000;

/** Stored with wall-clock `at` so a pause that is still being registered cannot skew `t`. */
export interface StoredEvent {
  seq: number;
  ev: RawEvent;
}

export interface EventLog {
  seq: number;
  /** User actions, page/route changes, errors, screenshots, marks: never evicted. */
  actions: StoredEvent[];
  /** Network rows: capped, oldest dropped first. */
  network: StoredEvent[];
  networkDropped: number;
}

export function emptyLog(): EventLog {
  return { seq: 0, actions: [], network: [], networkDropped: 0 };
}

export function toRecEvent(raw: RawEvent, clock: VideoClock, now = Date.now()): RecEvent {
  const { at, ...rest } = raw;
  const { t, duringPause } = videoTime(clock, at, now);
  return { ...rest, t, ...(duringPause ? { duringPause: true } : {}) } as RecEvent;
}

export function appendEvent(log: EventLog, ev: RawEvent, networkCap = NETWORK_CAP): void {
  const item = { seq: log.seq++, ev };
  if (ev.type !== "network") {
    log.actions.push(item);
    return;
  }
  log.network.push(item);
  const over = log.network.length - networkCap;
  if (over > 0) {
    log.network.splice(0, over);
    log.networkDropped += over;
  }
}

/** All events on the video clock, in wall-clock order (ties by arrival), so events inside a pause keep their order. */
export function orderedEvents(log: EventLog, clock: VideoClock, now = Date.now()): RecEvent[] {
  return [...log.actions, ...log.network]
    .sort((a, b) => a.ev.at - b.ev.at || a.seq - b.seq)
    .map((s) => toRecEvent(s.ev, clock, now));
}
