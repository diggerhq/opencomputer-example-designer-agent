import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { arch } from "node:process";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { defineTool } from "@opencomputer/agent";

const SITE_DIRECTORY = "/workspace/designer-site";
const TOOL_DIRECTORY = "/workspace/.designer-tools";
const CLOUDFLARED_VERSION = "2026.9.3";
const MAX_FILES = 500;
const MAX_BYTES = 25 * 1024 * 1024;

const RELEASES: Record<string, { name: string; sha256: string }> = {
  x64: {
    name: "cloudflared-linux-amd64",
    sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2",
  },
  arm64: {
    name: "cloudflared-linux-arm64",
    sha256: "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d",
  },
};

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let active:
  | { server: Server; tunnel: ChildProcess; url: string; files: number; bytes: number }
  | undefined;

async function siteStats(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Preview files may not be symbolic links");
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported preview entry: ${entry.name}`);
      const metadata = await stat(path);
      files += 1;
      bytes += metadata.size;
      if (files > MAX_FILES) throw new Error(`Preview exceeds ${MAX_FILES} files`);
      if (bytes > MAX_BYTES) throw new Error("Preview exceeds 25 MiB");
    }
  }

  await walk(root);
  await stat(join(root, "index.html"));
  return { files, bytes };
}

async function cloudflaredPath(): Promise<string> {
  const release = RELEASES[arch];
  if (!release) throw new Error(`Cloudflare Tunnel is not packaged for ${arch}`);

  const binary = join(TOOL_DIRECTORY, `cloudflared-${CLOUDFLARED_VERSION}-${arch}`);
  try {
    const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(binary));
    if (createHash("sha256").update(bytes).digest("hex") === release.sha256) return binary;
  } catch {
    // Download the pinned official binary below.
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${release.name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download cloudflared (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) throw new Error("Downloaded cloudflared checksum did not match");

  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, bytes, { mode: 0o755 });
  await chmod(binary, 0o755);
  return binary;
}

function startStaticServer(): Promise<Server> {
  const root = resolve(SITE_DIRECTORY);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }

      const url = new URL(request.url ?? "/", "http://preview.local");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = normalize(resolve(root, `.${pathname}`));
      if (file !== root && !file.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }

      const metadata = await stat(file);
      if (!metadata.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": metadata.size,
        "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    }
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function stopActive(): Promise<void> {
  if (!active) return Promise.resolve();
  const previous = active;
  active = undefined;
  previous.tunnel.kill("SIGTERM");
  return new Promise((resolveClose) => previous.server.close(() => resolveClose()));
}

async function startTunnel(binary: string, port: number, signal?: AbortSignal) {
  const tunnel = spawn(
    binary,
    ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${port}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timeout = setTimeout(() => {
      tunnel.kill("SIGTERM");
      reject(new Error(`Cloudflare Quick Tunnel did not become ready: ${output.slice(-2_000)}`));
    }, 30_000);
    const abort = () => {
      tunnel.kill("SIGTERM");
      reject(new Error("Preview sharing was cancelled"));
    };
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-32_000);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (!match) return;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolveUrl(match[0]);
    };
    tunnel.stdout.on("data", inspect);
    tunnel.stderr.on("data", inspect);
    tunnel.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    tunnel.once("exit", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new Error(`cloudflared exited with code ${code}: ${output.slice(-2_000)}`));
    });
    signal?.addEventListener("abort", abort, { once: true });
  });

  return { tunnel, url };
}

export const sharePreview = defineTool({
  name: "share_preview",
  description:
    "Serve /workspace/designer-site through an ephemeral Cloudflare Quick Tunnel and return its public HTTPS URL. The URL lasts only while this agent computer remains awake.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: {
    type: "object",
    properties: {
      url: { type: "string" },
      files: { type: "integer" },
      bytes: { type: "integer" },
      ephemeral: { type: "boolean" },
    },
    required: ["url", "files", "bytes", "ephemeral"],
    additionalProperties: false,
  },
  async run({ signal, reportProgress }) {
    const summary = await siteStats(SITE_DIRECTORY);
    await reportProgress({ stage: "starting-preview", ...summary });
    await stopActive();

    const [binary, server] = await Promise.all([cloudflaredPath(), startStaticServer()]);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Preview server failed to bind");
      const { tunnel, url } = await startTunnel(binary, address.port, signal);
      active = { server, tunnel, url, ...summary };
      tunnel.once("exit", () => {
        if (active?.tunnel === tunnel) {
          active = undefined;
          server.close();
        }
      });
      await reportProgress({ stage: "ready", url });
      return { url, ...summary, ephemeral: true };
    } catch (error) {
      server.close();
      throw error;
    }
  },
});
