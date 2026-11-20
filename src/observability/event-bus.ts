import type { EventPayloads, EventType, LabEvent } from "./events.ts";

/** Receives every event published on the bus. */
export type EventListener = (event: LabEvent) => void;

/** Where an event comes from: the agent, its run, and the current turn and step if any. */
export interface EventOrigin {
  readonly agent: string;
  readonly runId: string;
  readonly turn?: number;
  readonly step?: number;
}

/**
 * The lab's single event stream. Agents publish; sinks (the run recorder, the console, the dashboard,
 * the in-game narrator) subscribe.
 *
 * Publishing is synchronous and never throws: a failing listener is reported on stderr and the other
 * listeners still run, so observability can never break an agent.
 */
export class EventBus {
  readonly #listeners = new Set<EventListener>();
  #seq = 0;

  /** Stamps the event with a sequence number and time, then hands it to every listener. */
  publish<T extends EventType>(origin: EventOrigin, type: T, data: EventPayloads[T]): LabEvent {
    this.#seq += 1;
    const event = { seq: this.#seq, ts: new Date().toISOString(), type, ...origin, data } as LabEvent;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[event-bus] listener failed on ${type}:`, error);
      }
    }
    return event;
  }

  /** Registers a listener. Returns a function that removes it. */
  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** Publishes events for one origin. Agents hold one and update the turn and step as they go. */
export class EventPublisher {
  readonly #bus: EventBus;
  #origin: EventOrigin;

  /**
   * @param bus - The lab's event bus.
   * @param origin - The agent and run that publish through this publisher.
   */
  constructor(bus: EventBus, origin: EventOrigin) {
    this.#bus = bus;
    this.#origin = origin;
  }

  /** The current origin. */
  get origin(): EventOrigin {
    return this.#origin;
  }

  /** Changes the run, turn or step stamped on later events. */
  setOrigin(update: Partial<EventOrigin>): void {
    this.#origin = { ...this.#origin, ...update };
  }

  /** Publishes one event with the current origin. */
  emit<T extends EventType>(type: T, data: EventPayloads[T]): LabEvent {
    return this.#bus.publish(this.#origin, type, data);
  }
}
