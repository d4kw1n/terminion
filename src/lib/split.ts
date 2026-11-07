import type {
  SplitDirection,
  SplitNode,
  SplitRect,
  SplitSide,
} from "./types";

function leaf(tabId: string): SplitNode {
  return { type: "leaf", tabId };
}

export function splitLeaves(node: SplitNode | null | undefined): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [node.tabId];
  return node.children.flatMap(splitLeaves);
}

export function splitContains(node: SplitNode | null | undefined, tabId: string): boolean {
  return splitLeaves(node).includes(tabId);
}

function flatten(node: SplitNode): SplitNode {
  if (node.type === "leaf") return node;
  const children: SplitNode[] = [];
  for (const child of node.children.map(flatten)) {
    if (child.type === "split" && child.direction === node.direction) {
      children.push(...child.children);
    } else {
      children.push(child);
    }
  }
  if (children.length === 1) return children[0];
  return { type: "split", direction: node.direction, children };
}

export function removeSplitTab(node: SplitNode | null, tabId: string): SplitNode | null {
  if (!node) return null;
  if (node.type === "leaf") return node.tabId === tabId ? null : node;
  const children = node.children
    .map((child) => removeSplitTab(child, tabId))
    .filter((child): child is SplitNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return flatten({ type: "split", direction: node.direction, children });
}

function directionFor(side: SplitSide): SplitDirection {
  return side === "left" || side === "right" ? "row" : "column";
}

function insertAround(
  node: SplitNode,
  targetId: string,
  sourceId: string,
  side: SplitSide,
): SplitNode {
  if (node.type === "leaf") {
    if (node.tabId !== targetId) return node;
    const source = leaf(sourceId);
    const children = side === "left" || side === "top" ? [source, node] : [node, source];
    return { type: "split", direction: directionFor(side), children };
  }
  return {
    type: "split",
    direction: node.direction,
    children: node.children.map((child) => insertAround(child, targetId, sourceId, side)),
  };
}

/**
 * Insert `sourceId` next to `targetId`, replacing the current tree when the target
 * is not part of it (for example when dragging from the normal single-tab view).
 */
export function buildSplit(
  current: SplitNode | null,
  targetId: string,
  sourceId: string,
  side: SplitSide,
): SplitNode | null {
  if (targetId === sourceId) return current;
  let base = removeSplitTab(current, sourceId);
  if (!base || !splitContains(base, targetId)) base = leaf(targetId);
  return flatten(insertAround(base, targetId, sourceId, side));
}

function walk(
  node: SplitNode,
  left: number,
  top: number,
  width: number,
  height: number,
  out: SplitRect[],
) {
  if (node.type === "leaf") {
    out.push({ tabId: node.tabId, left, top, width, height });
    return;
  }
  const count = node.children.length;
  if (count === 0) return;
  if (node.direction === "row") {
    const childWidth = width / count;
    node.children.forEach((child, index) =>
      walk(child, left + childWidth * index, top, childWidth, height, out),
    );
  } else {
    const childHeight = height / count;
    node.children.forEach((child, index) =>
      walk(child, left, top + childHeight * index, width, childHeight, out),
    );
  }
}

export function layoutSplitRects(node: SplitNode): SplitRect[] {
  const out: SplitRect[] = [];
  walk(node, 0, 0, 100, 100, out);
  return out;
}

export function dropSideAt(
  event: { clientX: number; clientY: number; currentTarget: EventTarget | null },
  edge = 0.26,
): SplitSide | null {
  const element = event.currentTarget as HTMLElement | null;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (x < edge) return "left";
  if (x > 1 - edge) return "right";
  if (y < edge) return "top";
  if (y > 1 - edge) return "bottom";
  return null;
}
