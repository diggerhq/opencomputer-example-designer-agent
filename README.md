# OpenComputer Designer Agent

A small OpenComputer example that turns a design brief into a responsive static
site, validates it with shell commands, and returns a temporary public preview
URL through Cloudflare Quick Tunnels.

The agent declares the built-in `sandbox_exec` tool. Its first shell command
lazily starts an isolated session computer, and its work persists in
`/workspace/designer-site`.

## Why the tunnel lives in a tool

Each `sandbox_exec` call is a contained process unit. When the command exits,
OpenComputer terminates all descendant processes, including detached servers
and tunnels. A tunnel started directly by the model would therefore be dead by
the time the agent could return it.

This example uses a bundled `share_preview` tool. It serves only the fixed
`/workspace/designer-site` directory and launches a checksum-verified official
`cloudflared` binary outside the `sandbox_exec` command unit. Cloudflare assigns
a random `trycloudflare.com` URL with no account or tunnel credentials required.

The URL is ephemeral: it stops when the agent computer sleeps, restarts, or
terminates. That makes this a useful first preview primitive, not durable
hosting. A future native primitive can keep a stable edge URL and wake the
computer before proxying to its preview server.

## Setup

Requirements:

- Node.js 22 or newer
- an OpenComputer account

Install and link the app:

```bash
npm install
npx opencomputer link --create-project designer-agent-example
```

Deploy and try it:

```bash
npm run deploy -- --watch
npm run session -- "Design a launch page for a tiny typography studio called Kern."
```

The agent writes files under `/workspace/designer-site`, validates them, calls
the bundled sharing tool, and replies with a temporary `trycloudflare.com` URL.

## Security and lifecycle notes

- Generated previews are public. Do not place confidential data in the brief or
  generated site.
- Quick Tunnels require no Cloudflare account or credential. The tool downloads
  a pinned official Linux binary and verifies its SHA-256 digest before use.
- The agent explicitly refuses requests to inspect environment variables or
  unrelated workspace data, but prompt instructions are not a substitute for
  least-privilege credentials.
- Files in `/workspace` survive sandbox restarts for the session; the live URL
  does not. Call `share_preview` again after a restart to receive a new URL.

## Project layout

```text
opencomputer/
  project.ts
  agents/designer/
    agent.ts
    opencomputer.toml
    tools/share-preview.ts
```
