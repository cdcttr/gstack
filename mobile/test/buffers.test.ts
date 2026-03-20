import { describe, test, expect } from "bun:test";
import { CircularBuffer } from "../src/buffers";

describe("CircularBuffer", () => {
  test("push and toArray", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1); buf.push(2); buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  test("overwrites oldest when full", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1); buf.push(2); buf.push(3); buf.push(4);
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.totalAdded).toBe(4);
  });

  test("last(n) returns most recent entries", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1); buf.push(2); buf.push(3);
    expect(buf.last(2)).toEqual([2, 3]);
  });

  test("clear preserves totalAdded", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1); buf.push(2);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.totalAdded).toBe(2);
  });

  test("get and set by index", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(10); buf.push(20); buf.push(30);
    expect(buf.get(0)).toBe(10);
    expect(buf.get(2)).toBe(30);
    buf.set(1, 25);
    expect(buf.get(1)).toBe(25);
  });

  test("get returns undefined for out-of-bounds", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    expect(buf.get(-1)).toBeUndefined();
    expect(buf.get(1)).toBeUndefined();
  });
});
