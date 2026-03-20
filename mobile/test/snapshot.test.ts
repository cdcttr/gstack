import { describe, test, expect } from "bun:test";
import {
  walkSummaryTree,
  assignRefs,
  formatSnapshot,
  diffSnapshots,
  type InspectorNode,
} from "../src/snapshot";

// Sample data matching the shape returned by getRootWidgetSummaryTree
const SAMPLE_TREE = {
  description: "[root]",
  valueId: "inspector-0",
  widgetRuntimeType: "RootWidget",
  hasChildren: true,
  createdByLocalProject: false,
  children: [
    {
      description: "MyApp",
      valueId: "inspector-1",
      widgetRuntimeType: "MyApp",
      hasChildren: true,
      createdByLocalProject: true,
      children: [
        {
          description: "Scaffold",
          valueId: "inspector-2",
          widgetRuntimeType: "Scaffold",
          hasChildren: true,
          createdByLocalProject: true,
          children: [
            {
              description: "AppBar",
              valueId: "inspector-3",
              widgetRuntimeType: "AppBar",
              hasChildren: false,
              createdByLocalProject: true,
              creationLocation: { file: "lib/main.dart", line: 10, column: 8, name: "AppBar" },
            },
            {
              description: "ElevatedButton",
              valueId: "inspector-4",
              widgetRuntimeType: "ElevatedButton",
              hasChildren: false,
              createdByLocalProject: true,
              creationLocation: { file: "lib/main.dart", line: 15, column: 12, name: "ElevatedButton" },
            },
            {
              description: "TextField",
              valueId: "inspector-5",
              widgetRuntimeType: "TextField",
              hasChildren: false,
              createdByLocalProject: true,
              creationLocation: { file: "lib/main.dart", line: 20, column: 12, name: "TextField" },
            },
          ],
        },
      ],
    },
  ],
};

describe("walkSummaryTree", () => {
  test("extracts nodes from inspector tree", () => {
    const nodes = walkSummaryTree(SAMPLE_TREE);
    expect(nodes.length).toBeGreaterThan(0);
  });

  test("filters to createdByLocalProject nodes", () => {
    const nodes = walkSummaryTree(SAMPLE_TREE);
    // RootWidget is not local project, should be filtered
    const types = nodes.map((n) => n.widgetRuntimeType);
    expect(types).not.toContain("RootWidget");
    expect(types).toContain("ElevatedButton");
    expect(types).toContain("TextField");
  });

  test("each node has valueId and type", () => {
    const nodes = walkSummaryTree(SAMPLE_TREE);
    for (const node of nodes) {
      expect(node.valueId).toBeTruthy();
      expect(node.widgetRuntimeType).toBeTruthy();
    }
  });
});

describe("assignRefs", () => {
  test("assigns @w refs starting from @w1", () => {
    const nodes: InspectorNode[] = [
      { valueId: "v1", description: "Button", widgetRuntimeType: "ElevatedButton", createdByLocalProject: true, creationLocation: null },
      { valueId: "v2", description: "Text Field", widgetRuntimeType: "TextField", createdByLocalProject: true, creationLocation: null },
    ];
    const refMap = assignRefs(nodes);
    expect(refMap.has("@w1")).toBe(true);
    expect(refMap.has("@w2")).toBe(true);
    expect(refMap.get("@w1")!.description).toBe("Button");
    expect(refMap.get("@w2")!.description).toBe("Text Field");
  });

  test("does not assign refs beyond the node count", () => {
    const nodes: InspectorNode[] = [
      { valueId: "v1", description: "X", widgetRuntimeType: "Button", createdByLocalProject: true, creationLocation: null },
    ];
    const refMap = assignRefs(nodes);
    expect(refMap.has("@w1")).toBe(true);
    expect(refMap.has("@w2")).toBe(false);
  });
});

describe("formatSnapshot", () => {
  test("formats ref map as readable text", () => {
    const refMap = new Map([
      ["@w1", { valueId: "v1", type: "AppBar", description: "My App", creationLocation: null }],
      ["@w2", { valueId: "v2", type: "ElevatedButton", description: "Sign In", creationLocation: null }],
    ]);
    const output = formatSnapshot(refMap);
    expect(output).toContain("@w1");
    expect(output).toContain("[AppBar]");
    expect(output).toContain('"My App"');
    expect(output).toContain("@w2");
    expect(output).toContain("[ElevatedButton]");
    expect(output).toContain('"Sign In"');
  });

  test("returns message when empty", () => {
    const output = formatSnapshot(new Map());
    expect(output).toContain("No widgets found");
  });
});

describe("diffSnapshots", () => {
  test("returns empty string when identical", () => {
    const text = '@w1 [Button] "OK"';
    expect(diffSnapshots(text, text)).toBe("");
  });

  test("shows added lines", () => {
    const prev = '@w1 [Button] "OK"';
    const curr = '@w1 [Button] "OK"\n@w2 [Button] "Cancel"';
    const result = diffSnapshots(curr, prev);
    expect(result).toContain("Cancel");
    expect(result).toContain("+");
  });

  test("shows removed lines", () => {
    const prev = '@w1 [Button] "OK"\n@w2 [Button] "Cancel"';
    const curr = '@w1 [Button] "OK"';
    const result = diffSnapshots(curr, prev);
    expect(result).toContain("Cancel");
    expect(result).toContain("-");
  });

  test("handles null previous snapshot", () => {
    const result = diffSnapshots('@w1 [Button] "OK"', null);
    expect(result).toContain("No previous snapshot");
  });
});
