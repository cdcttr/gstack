/**
 * JSON-RPC 2.0 WebSocket client for the Dart VM Service Protocol.
 *
 * Handles:
 * - Request ID management and response correlation
 * - Flutter machine event parsing (from `flutter run --machine` stdout)
 * - Typed convenience methods for common VM Service calls
 * - Auto-reconnect (one attempt) on WebSocket disconnect
 * - Pending request timeout
 *
 * Reference: https://github.com/dart-lang/sdk/blob/main/runtime/vm/service/service.md
 */

export interface FlutterMachineEvent {
  event: string;
  params?: Record<string, any>;
}

export interface VmServiceResponse {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: { details?: string } };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class VmServiceClient {
  private _nextId = 0;
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private _isolateId: string | null = null;
  private _rootLibId: string | null = null;
  private _uri: string | null = null;
  private _connected = false;
  private _onEvent: ((event: VmServiceResponse) => void) | null = null;

  nextRequestId(): number {
    return ++this._nextId;
  }

  get isolateId(): string | null { return this._isolateId; }
  get rootLibId(): string | null { return this._rootLibId; }
  get connected(): boolean { return this._connected; }
  get uri(): string | null { return this._uri; }

  /** Register a handler for VM Service stream events (no id field) */
  onEvent(handler: (event: VmServiceResponse) => void): void {
    this._onEvent = handler;
  }

  // ── Static helpers (unit-testable without WebSocket) ──

  static buildRequest(id: number, method: string, params?: Record<string, any>): Record<string, any> {
    const msg: Record<string, any> = { jsonrpc: "2.0", id, method };
    if (params) msg.params = params;
    return msg;
  }

  static parseError(response: VmServiceResponse): string {
    if (!response.error) return "Unknown error";
    const msg = response.error.message;
    const details = response.error.data?.details;
    return details ? `${msg}: ${details}` : msg;
  }

  static isSuccess(response: VmServiceResponse): boolean {
    return response.result !== undefined && !response.error;
  }

  static isError(response: VmServiceResponse): boolean {
    return !!response.error;
  }

  static parseFlutterMachineEvent(line: string): FlutterMachineEvent | null {
    if (!line || !line.startsWith("[")) return null;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].event) {
        return parsed[0] as FlutterMachineEvent;
      }
      return null;
    } catch {
      return null;
    }
  }

  static extractVmServiceUri(event: FlutterMachineEvent): string | null {
    if (event.event !== "app.debugPort") return null;
    return event.params?.wsUri || null;
  }

  // ── WebSocket connection ──

  async connect(wsUri: string): Promise<void> {
    this._uri = wsUri;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUri);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timeout: ${wsUri}`));
      }, 10_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        this._connected = true;
        this._setupListeners(ws);
        resolve();
      });

      ws.addEventListener("error", (e) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error connecting to ${wsUri}`));
      });
    });
  }

  private _setupListeners(ws: WebSocket): void {
    ws.addEventListener("message", (event) => {
      let data: VmServiceResponse;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      // Correlate response to pending request
      if (data.id !== undefined && this.pendingRequests.has(data.id)) {
        const pending = this.pendingRequests.get(data.id)!;
        this.pendingRequests.delete(data.id);
        clearTimeout(pending.timer);
        if (data.error) {
          pending.reject(new Error(VmServiceClient.parseError(data)));
        } else {
          pending.resolve(data.result);
        }
        return;
      }

      // Stream event (no id)
      if (data.id === undefined && this._onEvent) {
        this._onEvent(data);
      }
    });

    ws.addEventListener("close", () => {
      this._connected = false;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("VM_SERVICE_DISCONNECTED"));
      }
      this.pendingRequests.clear();
    });
  }

  /** Send a JSON-RPC request and wait for the correlated response */
  async send(method: string, params?: Record<string, any>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (!this.ws || !this._connected) {
      throw new Error("VM_SERVICE_DISCONNECTED");
    }

    const id = this.nextRequestId();
    const msg = VmServiceClient.buildRequest(id, method, params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  close(): void {
    this._connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
  }

  // ── High-level convenience methods ──

  /** Get VM info and cache the main isolate ID */
  async getVM(): Promise<any> {
    const vm = await this.send("getVM");
    if (vm.isolates?.length > 0) {
      this._isolateId = vm.isolates[0].id;
    }
    return vm;
  }

  /** Get isolate details and cache the root library ID */
  async getIsolate(): Promise<any> {
    if (!this._isolateId) await this.getVM();
    const isolate = await this.send("getIsolate", { isolateId: this._isolateId });
    if (isolate.rootLib?.id) {
      this._rootLibId = isolate.rootLib.id;
    }
    return isolate;
  }

  /** Evaluate a Dart expression in the app's main isolate */
  async evaluate(expression: string): Promise<any> {
    if (!this._isolateId || !this._rootLibId) await this.getIsolate();
    return this.send("evaluate", {
      isolateId: this._isolateId,
      targetId: this._rootLibId,
      expression,
    });
  }

  /** Call a Flutter service extension */
  async callExtension(method: string, params?: Record<string, any>): Promise<any> {
    if (!this._isolateId) await this.getVM();
    return this.send(method, { isolateId: this._isolateId, ...params });
  }

  /** Get the widget inspector summary tree */
  async getRootWidgetSummaryTree(objectGroup: string, subtreeDepth: number = 5): Promise<any> {
    return this.callExtension("ext.flutter.inspector.getRootWidgetSummaryTree", {
      objectGroup,
      subtreeDepth: String(subtreeDepth),
    });
  }

  /** Get children of a widget inspector node */
  async getChildrenSummaryTree(objectGroup: string, valueId: string): Promise<any> {
    return this.callExtension("ext.flutter.inspector.getChildrenSummaryTree", {
      objectGroup,
      arg: valueId,
    });
  }

  /** Get detailed subtree (includes render object bounds) */
  async getDetailsSubtree(objectGroup: string, valueId: string, subtreeDepth: number = 2): Promise<any> {
    return this.callExtension("ext.flutter.inspector.getDetailsSubtree", {
      objectGroup,
      arg: valueId,
      subtreeDepth: String(subtreeDepth),
    });
  }

  /** Take a screenshot of a widget by its inspector valueId */
  async inspectorScreenshot(valueId: string, width: number, height: number): Promise<string> {
    const result = await this.callExtension("ext.flutter.inspector.screenshot", {
      id: valueId,
      width: String(width),
      height: String(height),
    });
    return result?.result || result;
  }

  /** Dispose a widget inspector object group */
  async disposeGroup(objectGroup: string): Promise<void> {
    await this.callExtension("ext.flutter.inspector.disposeGroup", { objectGroup });
  }

  /** Dump the semantics tree (requires accessibility enabled on device) */
  async dumpSemanticsTree(): Promise<string> {
    const result = await this.callExtension("ext.flutter.debugDumpSemanticsTreeInTraversalOrder");
    return result?.data || "";
  }

  /** Dump the full widget tree as text */
  async dumpWidgetTree(): Promise<string> {
    const result = await this.callExtension("ext.flutter.debugDumpApp");
    return result?.data || "";
  }

  /** Dump the render tree (includes sizes and positions) */
  async dumpRenderTree(): Promise<string> {
    const result = await this.callExtension("ext.flutter.debugDumpRenderTree");
    return result?.data || "";
  }

  /** Hot reload via reassemble */
  async reassemble(): Promise<any> {
    return this.callExtension("ext.flutter.reassemble");
  }

  /** Check if the widget tree is ready */
  async isWidgetTreeReady(): Promise<boolean> {
    const result = await this.callExtension("ext.flutter.inspector.isWidgetTreeReady");
    return result?.result === true;
  }

  /** Get HTTP profile (network requests) */
  async getHttpProfile(): Promise<any> {
    return this.callExtension("ext.dart.io.getHttpProfile");
  }

  /** Enable HTTP timeline logging */
  async enableHttpLogging(): Promise<void> {
    await this.callExtension("ext.dart.io.httpEnableTimelineLogging", { enabled: true });
  }
}
