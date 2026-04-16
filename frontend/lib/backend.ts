const EXPLICIT_API_BASE = process.env.NEXT_PUBLIC_API_URL || "";
const EXPLICIT_WS_BASE = process.env.NEXT_PUBLIC_WS_URL || "";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function getBrowserHttpProtocol(): "http:" | "https:" {
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    return "https:";
  }
  return "http:";
}

export function getBrowserBackendBase(): string {
  if (EXPLICIT_API_BASE) {
    return stripTrailingSlash(EXPLICIT_API_BASE);
  }
  if (typeof window !== "undefined") {
    return `${getBrowserHttpProtocol()}//${window.location.hostname}:8000`;
  }
  return "";
}

export function getBrowserBackendWsBase(): string {
  if (EXPLICIT_WS_BASE) {
    return stripTrailingSlash(EXPLICIT_WS_BASE);
  }
  if (EXPLICIT_API_BASE) {
    return stripTrailingSlash(EXPLICIT_API_BASE).replace(/^http/i, "ws");
  }
  if (typeof window !== "undefined") {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${window.location.hostname}:8000`;
  }
  return "";
}

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = getBrowserBackendBase();
  return base ? `${base}${normalizedPath}` : normalizedPath;
}
