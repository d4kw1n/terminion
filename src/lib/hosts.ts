import type { Host, HostInput } from "./types";

export function hostToInput(host: Host): HostInput {
  return {
    id: host.id,
    label: host.label,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    protocol: host.protocol,
    authType: host.authType,
    password: null,
    keyId: host.keyId,
    groupId: host.groupId,
    tags: host.tags,
    color: host.color,
    favorite: host.favorite,
    startupCommand: host.startupCommand,
    keepaliveSecs: host.keepaliveSecs,
    autoReconnect: host.autoReconnect,
  };
}

export function emptyHostInput(overrides: Partial<HostInput> = {}): HostInput {
  return {
    id: null,
    label: "",
    hostname: "",
    port: 22,
    username: "root",
    protocol: "ssh",
    authType: "password",
    password: "",
    keyId: null,
    groupId: null,
    tags: [],
    color: null,
    favorite: null,
    startupCommand: null,
    keepaliveSecs: 20,
    autoReconnect: true,
    ...overrides,
  };
}

export interface QuickTarget {
  username: string;
  hostname: string;
  port: number;
}

export function parseQuickConnect(raw: string): QuickTarget | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  if (!value.includes("@") && !value.includes(":") && !value.includes(".")) return null;
  const match = value.match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:@]+)(?::(\d+))?$/);
  if (!match) return null;
  const hostname = match[2].replace(/^\[|\]$/g, "");
  if (!hostname) return null;
  const port = match[3] ? Number(match[3]) : 22;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { username: match[1] || "root", hostname, port };
}
