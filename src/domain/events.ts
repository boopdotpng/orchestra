export type Unsubscribe = () => void;

export class EventBus<T> {
  private readonly listeners = new Set<(event: T) => void>();

  emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  on(listener: (event: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
