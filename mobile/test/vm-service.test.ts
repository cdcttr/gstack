import { describe, test, expect } from "bun:test";
import { VmServiceClient } from "../src/vm-service";

describe("VmServiceClient", () => {
  test("builds correct JSON-RPC 2.0 request", () => {
    const msg = VmServiceClient.buildRequest(1, "getVM", {});
    expect(msg).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getVM",
      params: {},
    });
  });

  test("builds request with isolateId param", () => {
    const msg = VmServiceClient.buildRequest(2, "evaluate", {
      isolateId: "isolates/123",
      expression: "1+1",
    });
    expect(msg.params.isolateId).toBe("isolates/123");
    expect(msg.params.expression).toBe("1+1");
  });

  test("builds request without params", () => {
    const msg = VmServiceClient.buildRequest(3, "getVM");
    expect(msg).toEqual({ jsonrpc: "2.0", id: 3, method: "getVM" });
  });

  test("increments request IDs", () => {
    const client = new VmServiceClient();
    expect(client.nextRequestId()).toBe(1);
    expect(client.nextRequestId()).toBe(2);
    expect(client.nextRequestId()).toBe(3);
  });

  test("parses VM Service error response", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid Request", data: { details: "missing isolateId" } },
    };
    const err = VmServiceClient.parseError(response);
    expect(err).toContain("Invalid Request");
    expect(err).toContain("missing isolateId");
  });

  test("parses error without data.details", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Bad request" },
    };
    const err = VmServiceClient.parseError(response);
    expect(err).toContain("Bad request");
  });

  test("identifies successful responses", () => {
    const success = { jsonrpc: "2.0", id: 1, result: { type: "VM" } };
    const error = { jsonrpc: "2.0", id: 1, error: { code: -1, message: "fail" } };
    expect(VmServiceClient.isSuccess(success)).toBe(true);
    expect(VmServiceClient.isSuccess(error)).toBe(false);
    expect(VmServiceClient.isError(success)).toBe(false);
    expect(VmServiceClient.isError(error)).toBe(true);
  });

  test("parses flutter machine JSON events", () => {
    const lines = [
      '[{"event":"app.debugPort","params":{"port":8181,"wsUri":"ws://127.0.0.1:8181/abc=/ws"}}]',
      '[{"event":"app.started"}]',
      '[{"event":"app.log","params":{"log":"hello"}}]',
    ];
    const events = lines.map(VmServiceClient.parseFlutterMachineEvent);
    expect(events[0]?.event).toBe("app.debugPort");
    expect(events[0]?.params?.wsUri).toBe("ws://127.0.0.1:8181/abc=/ws");
    expect(events[1]?.event).toBe("app.started");
    expect(events[2]?.event).toBe("app.log");
    expect(events[2]?.params?.log).toBe("hello");
  });

  test("returns null for non-JSON flutter machine lines", () => {
    expect(VmServiceClient.parseFlutterMachineEvent("Flutter run key commands:")).toBeNull();
    expect(VmServiceClient.parseFlutterMachineEvent("")).toBeNull();
    expect(VmServiceClient.parseFlutterMachineEvent("not json at all")).toBeNull();
  });

  test("extractVmServiceUri gets URI from debugPort event", () => {
    const event = { event: "app.debugPort", params: { port: 8181, wsUri: "ws://127.0.0.1:8181/abc=/ws" } };
    expect(VmServiceClient.extractVmServiceUri(event)).toBe("ws://127.0.0.1:8181/abc=/ws");
  });

  test("extractVmServiceUri returns null for other events", () => {
    expect(VmServiceClient.extractVmServiceUri({ event: "app.started" })).toBeNull();
    expect(VmServiceClient.extractVmServiceUri({ event: "app.debugPort", params: {} })).toBeNull();
  });

  test("builds extension call with objectGroup", () => {
    const msg = VmServiceClient.buildRequest(5, "ext.flutter.inspector.getRootWidgetSummaryTree", {
      isolateId: "isolates/123",
      objectGroup: "mobile-snapshot-1",
      subtreeDepth: "3",
    });
    expect(msg.method).toBe("ext.flutter.inspector.getRootWidgetSummaryTree");
    expect(msg.params.objectGroup).toBe("mobile-snapshot-1");
    expect(msg.params.subtreeDepth).toBe("3");
  });
});
