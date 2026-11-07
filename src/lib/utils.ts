export const HOST_COLORS = [
  "#7c5cff",
  "#22d3a6",
  "#38bdf8",
  "#fbbf24",
  "#fb7185",
  "#c084fc",
  "#34d399",
  "#f97316",
] as const;

export function hostColor(host: { color?: string | null; id: number; label: string }): string {
  if (host.color) return host.color;
  let hash = 0;
  for (let i = 0; i < host.label.length; i++) {
    hash = (hash * 31 + host.label.charCodeAt(i)) | 0;
  }
  return HOST_COLORS[Math.abs(hash + host.id) % HOST_COLORS.length];
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean.padEnd(6, "0");
  const num = parseInt(full.slice(0, 6), 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function initials(label: string): string {
  const words = label.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  const date = new Date(ts * 1000);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "Never";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return formatDate(ts);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function joinPath(dir: string, name: string): string {
  if (!dir || dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function splitPath(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const result: { name: string; path: string }[] = [{ name: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    result.push({ name: part, path: current });
  }
  return result;
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return 0;
    streak = idx === ti ? streak + 1 : 0;
    score += 4 + streak * 3 - Math.min(4, idx - ti);
    ti = idx + 1;
  }
  return Math.max(1, score);
}

export function colorForFingerprint(fingerprint: string): string {
  let hash = 0;
  for (const ch of fingerprint) hash = (hash * 33 + ch.charCodeAt(0)) | 0;
  return HOST_COLORS[Math.abs(hash) % HOST_COLORS.length];
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}
