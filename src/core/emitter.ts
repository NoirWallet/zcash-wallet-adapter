type EventMap = object;
type Listener<T> = (payload: T) => void;

export class TypedEventEmitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<E extends keyof Events>(event: E, listener: Listener<Events[E]>): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener<never>>();
    listeners.add(listener as Listener<never>);
    this.listeners.set(event, listeners);
  }

  off<E extends keyof Events>(event: E, listener: Listener<Events[E]>): void {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener as Listener<never>);
    if (listeners?.size === 0) {
      this.listeners.delete(event);
    }
  }

  protected emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      (listener as Listener<Events[E]>)(payload);
    }
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
