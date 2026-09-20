/**
 * A minimal typed event emitter.
 *
 * WHY NOT Node's EventEmitter
 * ---------------------------
 * Node's built-in emitter is untyped: `emit('candl', payload)` compiles fine and
 * fails silently at runtime, and listeners receive `any[]`. Since the engine-to-session
 * boundary is the most important seam in this backend (it is what guarantees a slow
 * client cannot corrupt candle data), it is worth 30 lines to have the compiler check
 * event names and payload shapes.
 *
 * It also keeps `off()` honest by returning an unsubscribe function from `on()`, which
 * removes the classic leak where a listener is registered with a bound method and can
 * never be removed because the bound reference was not retained.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function; callers should keep it
   * and invoke it on teardown rather than trying to reconstruct the listener.
   */
  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const erased = listener as (payload: never) => void;
    set.add(erased);
    return () => {
      set?.delete(erased);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy before iterating: a listener may unsubscribe itself (or another) during
    // dispatch, and mutating a Set while iterating it is a subtle source of skipped
    // listeners.
    for (const listener of [...set]) {
      (listener as (payload: Events[K]) => void)(payload);
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
