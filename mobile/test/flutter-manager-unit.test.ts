import { describe, test, expect } from "bun:test";
import {
  parseFlutterMachineEvent,
  extractVmServiceUri,
  FlutterAppState,
  WidgetRef,
  SysUiRef,
  RefStore,
} from "../src/flutter-manager";

describe("parseFlutterMachineEvent", () => {
  test("parses app.debugPort event", () => {
    const line = '[{"event":"app.debugPort","params":{"port":8181,"wsUri":"ws://127.0.0.1:8181/abc=/ws"}}]';
    const event = parseFlutterMachineEvent(line);
    expect(event?.event).toBe("app.debugPort");
    expect(event?.params?.wsUri).toBe("ws://127.0.0.1:8181/abc=/ws");
  });

  test("parses app.started event", () => {
    const line = '[{"event":"app.started"}]';
    const event = parseFlutterMachineEvent(line);
    expect(event?.event).toBe("app.started");
  });

  test("parses app.log event", () => {
    const line = '[{"event":"app.log","params":{"log":"Hello from Dart","stackTrace":null}}]';
    const event = parseFlutterMachineEvent(line);
    expect(event?.event).toBe("app.log");
    expect(event?.params?.log).toBe("Hello from Dart");
  });

  test("returns null for non-JSON lines", () => {
    expect(parseFlutterMachineEvent("Flutter run key commands:")).toBeNull();
    expect(parseFlutterMachineEvent("")).toBeNull();
  });

  test("returns null for non-array JSON", () => {
    expect(parseFlutterMachineEvent('{"not":"array"}')).toBeNull();
  });
});

describe("extractVmServiceUri", () => {
  test("extracts URI from debugPort event", () => {
    const event = { event: "app.debugPort", params: { port: 8181, wsUri: "ws://127.0.0.1:8181/abc=/ws" } };
    expect(extractVmServiceUri(event)).toBe("ws://127.0.0.1:8181/abc=/ws");
  });

  test("returns null for non-debugPort events", () => {
    expect(extractVmServiceUri({ event: "app.started" })).toBeNull();
  });

  test("returns null when params missing wsUri", () => {
    expect(extractVmServiceUri({ event: "app.debugPort", params: { port: 8181 } })).toBeNull();
  });
});

describe("FlutterAppState", () => {
  test("initial state is 'launching'", () => {
    const state = new FlutterAppState();
    expect(state.status).toBe("launching");
  });

  test("transitions to 'running' on app.started", () => {
    const state = new FlutterAppState();
    state.handleEvent({ event: "app.started" });
    expect(state.status).toBe("running");
  });

  test("transitions to 'stopped' on app.stop", () => {
    const state = new FlutterAppState();
    state.handleEvent({ event: "app.started" });
    state.handleEvent({ event: "app.stop" });
    expect(state.status).toBe("stopped");
  });

  test("transitions through debugPort", () => {
    const state = new FlutterAppState();
    state.handleEvent({ event: "app.debugPort", params: { wsUri: "ws://..." } });
    expect(state.status).toBe("connecting");
  });

  test("ignores unknown events", () => {
    const state = new FlutterAppState();
    state.handleEvent({ event: "unknown.thing" });
    expect(state.status).toBe("launching");
  });
});

describe("RefStore", () => {
  test("stores and retrieves @w refs", () => {
    const store = new RefStore();
    const ref: WidgetRef = {
      valueId: "inspector-1",
      type: "ElevatedButton",
      description: "Sign In",
      creationLocation: null,
    };
    store.setWidgetRefs(new Map([["@w1", ref]]));
    expect(store.getWidgetRef("@w1")).toEqual(ref);
    expect(store.getWidgetRef("@w2")).toBeUndefined();
  });

  test("stores and retrieves @s refs", () => {
    const store = new RefStore();
    const ref: SysUiRef = { text: "Allow", className: "Button", bounds: { x: 720, y: 1250 } };
    store.setSysUiRefs(new Map([["@s1", ref]]));
    expect(store.getSysUiRef("@s1")).toEqual(ref);
    expect(store.getSysUiRef("@s2")).toBeUndefined();
  });

  test("@w and @s namespaces are independent", () => {
    const store = new RefStore();
    const wRef: WidgetRef = { valueId: "v1", type: "Button", description: "OK", creationLocation: null };
    const sRef: SysUiRef = { text: "Allow", className: "Button", bounds: { x: 100, y: 200 } };
    store.setWidgetRefs(new Map([["@w1", wRef]]));
    store.setSysUiRefs(new Map([["@s1", sRef]]));
    expect(store.getWidgetRef("@w1")?.description).toBe("OK");
    expect(store.getSysUiRef("@s1")?.text).toBe("Allow");
  });

  test("clearWidgetRefs empties widget map only", () => {
    const store = new RefStore();
    store.setWidgetRefs(new Map([["@w1", { valueId: "v1", type: "B", description: "X", creationLocation: null }]]));
    store.setSysUiRefs(new Map([["@s1", { text: "Y", className: "C", bounds: { x: 0, y: 0 } }]]));
    store.clearWidgetRefs();
    expect(store.getWidgetRef("@w1")).toBeUndefined();
    expect(store.getSysUiRef("@s1")).toBeDefined();
  });

  test("stores and retrieves last snapshot text", () => {
    const store = new RefStore();
    expect(store.lastSnapshot).toBeNull();
    store.lastSnapshot = '@w1 [Button] "OK"';
    expect(store.lastSnapshot).toBe('@w1 [Button] "OK"');
  });

  test("tracks object group names", () => {
    const store = new RefStore();
    const group = store.nextObjectGroup();
    expect(group).toBe("mobile-snapshot-1");
    expect(store.nextObjectGroup()).toBe("mobile-snapshot-2");
    expect(store.currentObjectGroup).toBe("mobile-snapshot-2");
  });
});
