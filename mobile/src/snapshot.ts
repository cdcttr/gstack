/**
 * Snapshot: widget inspector tree → @w refs
 *
 * Analogous to browse/src/snapshot.ts. Converts the Flutter widget
 * inspector summary tree into a flat list of @w refs that Claude
 * can use to interact with the app.
 *
 * Primary data source: ext.flutter.inspector.getRootWidgetSummaryTree
 * Secondary: ext.flutter.debugDumpSemanticsTreeInTraversalOrder
 * Verbose: ext.flutter.debugDumpApp
 */

import * as Diff from "diff";
import type { FlutterManager } from "./flutter-manager";
import type { WidgetRef } from "./flutter-manager";

// ── Types ──

export interface InspectorNode {
  valueId: string;
  description: string;
  widgetRuntimeType: string;
  createdByLocalProject: boolean;
  creationLocation: { file: string; line: number; column: number; name?: string } | null;
  children?: InspectorNode[];
}

// ── Tree walking ──

/**
 * Walk the inspector summary tree and extract app-level nodes.
 * Filters to nodes created by the local project (not framework internals).
 */
export function walkSummaryTree(root: any, depth: number = 0): InspectorNode[] {
  const nodes: InspectorNode[] = [];

  if (root.createdByLocalProject) {
    nodes.push({
      valueId: root.valueId,
      description: root.description || root.widgetRuntimeType || "",
      widgetRuntimeType: root.widgetRuntimeType || "",
      createdByLocalProject: true,
      creationLocation: root.creationLocation || null,
    });
  }

  if (root.children && Array.isArray(root.children)) {
    for (const child of root.children) {
      nodes.push(...walkSummaryTree(child, depth + 1));
    }
  }

  return nodes;
}

// ── Ref assignment ──

/**
 * Assign @w1, @w2, ... refs to a list of inspector nodes.
 * Returns a Map<string, WidgetRef> for storage in FlutterManager.
 */
export function assignRefs(nodes: InspectorNode[]): Map<string, WidgetRef> {
  const refMap = new Map<string, WidgetRef>();
  let counter = 1;

  for (const node of nodes) {
    const ref = `@w${counter}`;
    refMap.set(ref, {
      valueId: node.valueId,
      type: node.widgetRuntimeType,
      description: node.description,
      creationLocation: node.creationLocation,
    });
    counter++;
  }

  return refMap;
}

// ── Formatting ──

/**
 * Format a ref map into the text output Claude sees.
 */
export function formatSnapshot(refMap: Map<string, WidgetRef>): string {
  if (refMap.size === 0) return "No widgets found in snapshot.";

  const lines: string[] = [];
  for (const [ref, widget] of refMap) {
    let line = `  ${ref} [${widget.type}] "${widget.description}"`;
    if (widget.creationLocation) {
      const loc = widget.creationLocation;
      const file = loc.file.replace(/^.*\/lib\//, "lib/");
      line += ` (${file}:${loc.line})`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ── Diffing ──

/**
 * Diff current snapshot text against previous.
 * Returns empty string if identical, or a unified diff.
 */
export function diffSnapshots(current: string, previous: string | null): string {
  if (previous === null) return "No previous snapshot to diff against.";
  if (current === previous) return "";

  const changes = Diff.diffLines(previous, current);
  const lines: string[] = [];
  for (const change of changes) {
    const prefix = change.added ? "+" : change.removed ? "-" : " ";
    const text = change.value.replace(/\n$/, "");
    for (const line of text.split("\n")) {
      lines.push(`${prefix} ${line}`);
    }
  }
  return lines.join("\n");
}

// ── Full snapshot command handler ──

/**
 * Handle the `snapshot` command.
 * Flags: -v (verbose/full tree), -s (semantics), -D (diff), -a (annotated screenshot)
 */
export async function handleSnapshot(fm: FlutterManager, args: string[]): Promise<string> {
  const flags = new Set(args.filter((a) => a.startsWith("-")));

  // Verbose mode: full widget tree as text
  if (flags.has("-v")) {
    return await fm.vmService.dumpWidgetTree();
  }

  // Semantics mode: dump semantics tree
  if (flags.has("-s")) {
    const dump = await fm.vmService.dumpSemanticsTree();
    if (dump.includes("Semantics not generated")) {
      return dump + "\n\nHint: Enable TalkBack on the device or use `snapshot` (without -s) for the widget inspector tree.";
    }
    return dump;
  }

  // Default: widget inspector summary tree → @w refs
  const prevGroup = fm.refs.currentObjectGroup;
  const objectGroup = fm.refs.nextObjectGroup();

  const tree = await fm.vmService.getRootWidgetSummaryTree(objectGroup);
  const root = tree?.result || tree;

  const nodes = walkSummaryTree(root);
  const refMap = assignRefs(nodes);

  fm.refs.setWidgetRefs(refMap);

  const snapshotText = formatSnapshot(refMap);

  // Diff mode
  if (flags.has("-D")) {
    const diffResult = diffSnapshots(snapshotText, fm.refs.lastSnapshot);
    fm.refs.lastSnapshot = snapshotText;

    // Dispose previous group
    if (prevGroup) {
      try { await fm.vmService.disposeGroup(prevGroup); } catch {}
    }

    if (diffResult === "") return "No changes since last snapshot.";
    return `Changes:\n${diffResult}\n\nCurrent snapshot:\n${snapshotText}`;
  }

  fm.refs.lastSnapshot = snapshotText;

  // Dispose previous group
  if (prevGroup) {
    try { await fm.vmService.disposeGroup(prevGroup); } catch {}
  }

  return snapshotText;
}
