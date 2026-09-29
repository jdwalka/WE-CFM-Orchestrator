import { EventRegistry } from './EventTypes';

type EventKey = keyof EventRegistry;
type EventCallback<T extends EventKey> = (payload: EventRegistry[T]) => void;

class EventBus {
  private subscribers = new Map<EventKey, EventCallback<any>[]>();

  // Subscribe to an event
  public on<T extends EventKey>(event: T, callback: EventCallback<T>): void {
    const currentSubscribers = this.subscribers.get(event) || [];
    this.subscribers.set(event, [...currentSubscribers, callback]);
  }

  // Broadcast an event
  public emit<T extends EventKey>(event: T, payload: EventRegistry[T]): void {
    const currentSubscribers = this.subscribers.get(event) || [];
    currentSubscribers.forEach(callback => {
      try {
        callback(payload);
      } catch (error) {
        // Prevents one broken subscriber from crashing the execution engine
        console.error(`[EventBus] Error in subscriber for ${event}:`, error);
      }
    });
  }
}

// Export as a singleton
export const eventBus = new EventBus();
