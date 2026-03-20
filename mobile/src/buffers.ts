/**
 * Shared buffers — extracted to break circular dependency
 * between server.ts and flutter-manager.ts.
 *
 * CircularBuffer<T>: O(1) insert ring buffer with fixed capacity.
 */

export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private _size: number = 0;
  private _totalAdded: number = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(entry: T): void {
    const index = (this.head + this._size) % this.capacity;
    this.buffer[index] = entry;
    if (this._size < this.capacity) {
      this._size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    this._totalAdded++;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity] as T);
    }
    return result;
  }

  last(n: number): T[] {
    const count = Math.min(n, this._size);
    const result: T[] = [];
    const start = (this.head + this._size - count) % this.capacity;
    for (let i = 0; i < count; i++) {
      result.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return result;
  }

  get length(): number { return this._size; }
  get totalAdded(): number { return this._totalAdded; }

  clear(): void {
    this.head = 0;
    this._size = 0;
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this._size) return undefined;
    return this.buffer[(this.head + index) % this.capacity];
  }

  set(index: number, entry: T): void {
    if (index < 0 || index >= this._size) return;
    this.buffer[(this.head + index) % this.capacity] = entry;
  }
}

export interface LogEntry {
  timestamp: number;
  level: string;
  text: string;
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  size?: number;
}

const HIGH_WATER_MARK = 50_000;

export const consoleBuffer = new CircularBuffer<LogEntry>(HIGH_WATER_MARK);
export const networkBuffer = new CircularBuffer<NetworkEntry>(HIGH_WATER_MARK);
