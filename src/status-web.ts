import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { buildStatusModel, findLatestRunDir } from "./status.js";
import { STATUS_DASHBOARD_HTML } from "./status-web-assets.js";

export interface StatusWebOptions {
  runDir?: string;
  port: number;
  open: boolean;
}

export interface StatusWebHandle {
  server: Server;
  url: string;
  runDir: string;
  close(): Promise<void>;
}

export function parseStatusWebArgs(
  args: readonly string[],
  repoRoot: string,
): StatusWebOptions {
  if (args.includes("--json")) {
    throw new Error("--web cannot be combined with --json");
  }
  let runDir: string | undefined;
  let port = 0;
  let open = true;
  const allowed = new Set(["--web", "--run", "--port", "--no-open"]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new Error(`Unknown status option: ${flag}`);
    if (flag === "--run" || flag === "--port") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === "--run") {
        runDir = isAbsolute(value) ? value : resolve(repoRoot, value);
      } else {
        if (!/^\d+$/.test(value)) {
          throw new Error("--port must be an integer from 1 to 65535");
        }
        port = Number(value);
        if (port < 1 || port > 65_535) {
          throw new Error("--port must be an integer from 1 to 65535");
        }
      }
    } else if (flag === "--no-open") {
      open = false;
    }
  }
  return { runDir, port, open };
}

function resolveRunDir(repoRoot: string, requested?: string): string {
  if (requested) {
    if (!existsSync(requested)) {
      throw new Error(`Run directory not found: ${requested}`);
    }
    return requested;
  }
  const logsDir = join(repoRoot, ".afk", "logs");
  if (!existsSync(logsDir)) {
    throw new Error(
      `No .afk/logs directory under ${repoRoot} - has a pipeline run happened here?`,
    );
  }
  const latest = findLatestRunDir(repoRoot);
  if (!latest) throw new Error(`No run directories found under ${logsDir}`);
  return latest;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  child.once("error", () => undefined);
}

export async function startStatusWebServer(
  repoRoot: string,
  options: StatusWebOptions,
): Promise<StatusWebHandle> {
  const runDir = resolveRunDir(repoRoot, options.runDir);
  const initial = buildStatusModel(runDir, repoRoot);
  if (!initial.ok) throw new Error(initial.message);

  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(STATUS_DASHBOARD_HTML);
      return;
    }
    if (path === "/api/status") {
      const built = buildStatusModel(runDir, repoRoot);
      if (!built.ok) {
        response.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ error: built.message }));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(built.model));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Status server did not expose a TCP address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  if (options.open) openBrowser(url);

  return {
    server,
    url,
    runDir,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

export async function runStatusWeb(
  args: readonly string[],
  repoRoot: string,
): Promise<StatusWebHandle> {
  return startStatusWebServer(repoRoot, parseStatusWebArgs(args, repoRoot));
}
