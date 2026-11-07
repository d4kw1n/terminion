import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon, type IconName } from "./Icon";
import { Modal } from "./Modal";
import { SystemStats } from "./SystemStats";
import { dropSideAt, splitContains } from "../lib/split";
import { useStore } from "../store";
import type { PageKind, SplitSide, Tab, TabGroup } from "../lib/types";

const PAGE_ICONS: Record<PageKind, IconName> = {
  snippets: "code",
  forwards: "swap",
  keys: "key",
  known: "shield",
  settings: "settings",
};

const GROUP_COLORS = [
  "#7c5cff",
  "#38bdf8",
  "#22d3a6",
  "#fbbf24",
  "#fb7185",
  "#c084fc",
  "#f97316",
  "#34d399",
];

type TabDialog =
  | { type: "tab"; tabId: string; value: string }
  | {
      type: "group";
      groupId?: string;
      tabId?: string;
      name: string;
      color: string;
    }
  | null;

interface TabSegment {
  group?: TabGroup;
  tabs: Tab[];
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "terminal") return <Icon name="terminal" size={15} />;
  if (tab.kind === "sftp") return <Icon name="folder" size={15} />;
  return <Icon name={PAGE_ICONS[tab.page as PageKind] ?? "code"} size={15} />;
}

function statusClass(tab: Tab) {
  if (tab.kind === "page") return "";
  if (tab.status === "connected") return "is-live";
  if (tab.status === "connecting" || tab.status === "reconnecting") return "is-pending";
  if (tab.status === "disconnected") return "is-dead";
  return "";
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const tabGroups = useStore((s) => s.tabGroups);
  const split = useStore((s) => s.split);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const renameTab = useStore((s) => s.renameTab);
  const moveTab = useStore((s) => s.moveTab);
  const createTabGroup = useStore((s) => s.createTabGroup);
  const addTabToGroup = useStore((s) => s.addTabToGroup);
  const removeTabFromGroup = useStore((s) => s.removeTabFromGroup);
  const renameTabGroup = useStore((s) => s.renameTabGroup);
  const deleteTabGroup = useStore((s) => s.deleteTabGroup);
  const toggleTabGroup = useStore((s) => s.toggleTabGroup);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setTabDrag = useStore((s) => s.setTabDrag);
  const splitTab = useStore((s) => s.splitTab);

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [dialog, setDialog] = useState<TabDialog>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickUntilRef = useRef(0);

  const groupById = useMemo(
    () => new Map(tabGroups.map((group) => [group.id, group])),
    [tabGroups],
  );

  const segments = useMemo(() => {
    const result: TabSegment[] = [];
    for (const tab of tabs) {
      const group = tab.groupId ? groupById.get(tab.groupId) : undefined;
      const previous = result[result.length - 1];
      if (group && previous?.group?.id === group.id) {
        previous.tabs.push(tab);
      } else if (!group && previous && !previous.group) {
        previous.tabs.push(tab);
      } else {
        result.push({ group, tabs: [tab] });
      }
    }
    return result;
  }, [tabs, groupById]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      setTabDrag(null);
      document.body.classList.remove("is-tab-dragging");
    },
    [setTabDrag],
  );

  const openTabRename = (tab: Tab) =>
    setDialog({
      type: "tab",
      tabId: tab.id,
      value: tab.customTitle ?? tab.title,
    });

  const openNewGroup = (tab: Tab) =>
    setDialog({
      type: "group",
      tabId: tab.id,
      name: `Group ${tabGroups.length + 1}`,
      color: GROUP_COLORS[tabGroups.length % GROUP_COLORS.length],
    });

  const openGroupRename = (group: TabGroup) =>
    setDialog({
      type: "group",
      groupId: group.id,
      name: group.name,
      color: group.color,
    });

  const submitDialog = () => {
    if (!dialog) return;
    if (dialog.type === "tab") {
      renameTab(dialog.tabId, dialog.value);
    } else if (dialog.groupId) {
      renameTabGroup(dialog.groupId, dialog.name, dialog.color);
    } else if (dialog.tabId) {
      createTabGroup(dialog.tabId, dialog.name, dialog.color);
    }
    setDialog(null);
  };

  const tabMenu = (tab: Tab): MenuItem[] => {
    const index = tabs.findIndex((item) => item.id === tab.id);
    return [
      {
        label: "Rename tab…",
        icon: "edit",
        onClick: () => openTabRename(tab),
      },
      {
        label: "Move left",
        icon: "chevron-left",
        disabled: index <= 0,
        onClick: () => tabs[index - 1] && moveTab(tab.id, tabs[index - 1].id, false),
      },
      {
        label: "Move right",
        icon: "chevron-right",
        disabled: index < 0 || index >= tabs.length - 1,
        onClick: () => tabs[index + 1] && moveTab(tab.id, tabs[index + 1].id, true),
      },
      { separator: true },
      {
        label: "New tab group…",
        icon: "folder-plus",
        onClick: () => openNewGroup(tab),
      },
      ...tabGroups
        .filter((group) => group.id !== tab.groupId)
        .map((group) => ({
          label: `Add to “${group.name}”`,
          icon: "folder" as const,
          onClick: () => addTabToGroup(tab.id, group.id),
        })),
      ...(tab.groupId
        ? [
            {
              label: "Remove from group",
              icon: "x" as const,
              onClick: () => removeTabFromGroup(tab.id),
            },
          ]
        : []),
      { separator: true },
      {
        label: "Close tab",
        icon: "x",
        danger: true,
        onClick: () => closeTab(tab.id),
      },
    ];
  };

  const groupMenu = (group: TabGroup): MenuItem[] => [
    {
      label: group.collapsed ? "Expand group" : "Collapse group",
      icon: group.collapsed ? "chevron-down" : "chevron-right",
      onClick: () => toggleTabGroup(group.id),
    },
    {
      label: "Rename group…",
      icon: "edit",
      onClick: () => openGroupRename(group),
    },
    { separator: true },
    {
      label: "Ungroup tabs",
      icon: "x",
      onClick: () => deleteTabGroup(group.id),
    },
  ];

  const startTabDrag = (event: ReactPointerEvent<HTMLButtonElement>, tab: Tab) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tab-close")) return;

    dragCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const canSplit = tab.kind === "terminal";
    let dragging = false;

    const move = (pointer: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 6) {
          return;
        }
        dragging = true;
        document.body.classList.add("is-tab-dragging");
      }
      pointer.preventDefault();

      let targetTabId: string | null = null;
      let side: SplitSide | null = null;
      let rect: { left: number; top: number; width: number; height: number } | null =
        null;
      let tabDrop: {
        tabId: string;
        after: boolean;
        x: number;
        y: number;
        height: number;
      } | null = null;

      if (canSplit) {
        const pane = document
          .elementFromPoint(pointer.clientX, pointer.clientY)
          ?.closest<HTMLElement>("[data-split-tab-id]");
        if (pane?.dataset.splitTabId && pane.dataset.splitTabId !== tab.id) {
          side = dropSideAt({
            clientX: pointer.clientX,
            clientY: pointer.clientY,
            currentTarget: pane,
          });
          if (side) {
            targetTabId = pane.dataset.splitTabId;
            const bounds = pane.getBoundingClientRect();
            rect = {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            };
          }
        }
      }

      if (!targetTabId) {
        const tabElement = document
          .elementFromPoint(pointer.clientX, pointer.clientY)
          ?.closest<HTMLElement>("[data-tab-id]");
        const target = tabElement?.dataset.tabId;
        if (target && target !== tab.id) {
          const bounds = tabElement.getBoundingClientRect();
          const after = pointer.clientX > bounds.left + bounds.width / 2;
          tabDrop = {
            tabId: target,
            after,
            x: after ? bounds.right : bounds.left,
            y: bounds.top,
            height: bounds.height,
          };
        }
      }

      setTabDrag({
        tabId: tab.id,
        x: pointer.clientX,
        y: pointer.clientY,
        targetTabId,
        side,
        rect,
        tabDrop,
      });
    };

    const finish = () => {
      cleanup();
      if (dragging) {
        const drag = useStore.getState().tabDrag;
        if (drag?.targetTabId && drag.side) {
          splitTab(drag.targetTabId, tab.id, drag.side);
        } else if (drag?.tabDrop) {
          moveTab(tab.id, drag.tabDrop.tabId, drag.tabDrop.after);
        }
        suppressClickUntilRef.current = performance.now() + 250;
      }
      setTabDrag(null);
      document.body.classList.remove("is-tab-dragging");
    };

    const cancel = () => {
      cleanup();
      setTabDrag(null);
      document.body.classList.remove("is-tab-dragging");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKeyDown);
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKeyDown);
  };

  const renderTab = (tab: Tab) => {
    const group = tab.groupId ? groupById.get(tab.groupId) : undefined;
    const style = group
      ? ({ "--tab-group-color": group.color } as CSSProperties)
      : undefined;
    return (
      <button
        key={tab.id}
        data-tab-id={tab.id}
        className={`tab ${tab.id === activeTabId ? "is-active" : ""} ${
          group ? "is-grouped" : ""
        } tab--draggable`}
        style={style}
        onPointerDown={(event) => startTabDrag(event, tab)}
        onClick={() => {
          if (performance.now() < suppressClickUntilRef.current) return;
          setActiveTab(tab.id);
        }}
        onDoubleClick={() => {
          if (performance.now() < suppressClickUntilRef.current) return;
          openTabRename(tab);
        }}
        onAuxClick={(event) => {
          if (event.button === 1) closeTab(tab.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY, items: tabMenu(tab) });
        }}
        title={`${tab.customTitle ?? tab.subtitle ?? tab.title} · double-click to rename`}
      >
        <span className={`tab-icon ${statusClass(tab)}`}>
          <TabIcon tab={tab} />
        </span>
        <span className="tab-title">{tab.customTitle ?? tab.title}</span>
        {tab.kind !== "page" && (
          <span className={`tab-dot ${statusClass(tab)}`} aria-hidden="true" />
        )}
        {split && splitContains(split, tab.id) && (
          <span className="tab-split-mark" title="In split layout" />
        )}
        <span
          className="tab-close"
          role="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            closeTab(tab.id);
          }}
          title="Close tab"
        >
          <Icon name="x" size={12} strokeWidth={2.2} />
        </span>
      </button>
    );
  };

  return (
    <>
      <div className="tabbar">
        <div className="tabbar-scroll" ref={scrollRef}>
          {segments.map((segment, index) => {
            if (!segment.group) return segment.tabs.map(renderTab);
            const group = segment.group;
            const activeInside = segment.tabs.some((tab) => tab.id === activeTabId);
            return (
              <div
                key={`${group.id}-${index}`}
                className={`tab-group ${group.collapsed ? "is-collapsed" : ""}`}
                style={{ "--tab-group-color": group.color } as CSSProperties}
              >
                <button
                  className={`tab-group-chip ${activeInside ? "has-active" : ""}`}
                  onClick={() => toggleTabGroup(group.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({
                      x: event.clientX,
                      y: event.clientY,
                      items: groupMenu(group),
                    });
                  }}
                  title={`${group.name} · ${
                    group.collapsed ? "click to expand" : "click to collapse"
                  }`}
                >
                  <span className="tab-group-dot" />
                  <span className="tab-group-name">{group.name}</span>
                  <span className="tab-group-count">{segment.tabs.length}</span>
                  <Icon
                    name={group.collapsed ? "chevron-right" : "chevron-down"}
                    size={12}
                  />
                </button>
                {!group.collapsed && (
                  <div className="tab-group-tabs">{segment.tabs.map(renderTab)}</div>
                )}
              </div>
            );
          })}
        </div>
        <div className="tabbar-actions">
          <SystemStats />
          <button
            className="tabbar-action"
            onClick={() => setPaletteOpen(true)}
            title="New connection · Ctrl K"
          >
            <Icon name="plus" size={17} />
          </button>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.type === "tab"
            ? "Rename tab"
            : dialog?.groupId
              ? "Rename tab group"
              : "New tab group"
        }
        subtitle={
          dialog?.type === "tab"
            ? "Leave the name empty to use the host label."
            : "Group related sessions and collapse them when you need space."
        }
        width={460}
        footer={
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className="btn btn-primary primary-action" onClick={submitDialog}>
              {dialog?.type === "tab" || dialog?.groupId ? "Save" : "Create group"}
            </button>
          </>
        }
      >
        {dialog?.type === "tab" ? (
          <div className="field">
            <label htmlFor="tab-rename">Tab name</label>
            <input
              id="tab-rename"
              className="input"
              value={dialog.value}
              placeholder="Use default label"
              onChange={(event) =>
                setDialog({ ...dialog, value: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") submitDialog();
              }}
            />
          </div>
        ) : dialog ? (
          <>
            <div className="field">
              <label htmlFor="group-name">Group name</label>
              <input
                id="group-name"
                className="input"
                value={dialog.name}
                onChange={(event) =>
                  setDialog({ ...dialog, name: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitDialog();
                }}
              />
            </div>
            <div className="field">
              <label>Color</label>
              <div className="swatches">
                {GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    className={`swatch ${dialog.color === color ? "is-selected" : ""}`}
                    style={{ background: color }}
                    title={color}
                    aria-label={`Group color ${color}`}
                    onClick={() => setDialog({ ...dialog, color })}
                  />
                ))}
              </div>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}
