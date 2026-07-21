// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deployment entrypoint. tini is PID 1 (zombie reaping + signal delivery); this
// Bun process is tini's single child. It PLANS what to run from the environment
// — a `RunPlan` of one-shot setup steps + long-running apps — and hands the plan
// to a `Runner` adaptor that supervises it. `BunRunner` is the default; to move
// to a stricter process supervisor, swap the adaptor here, not this planning.
//
// Each app is delegated to a workspace package.json script (`bun run <script>`
// in the workspace dir) so each owns its dev/start command. Mode and which apps
// run are env-driven:
//   DEV          run watch/HMR dev scripts + `bun install` first  (default false)
//   RUN_SERVER   run @quip/server   (default true)
//   RUN_INDEXER  run @quip/indexer  (default true)
//   RUN_FRONTEND run @quip/frontend vite dev server (default true, DEV-only)

import type { Application, RunPlan, SetupStep } from "@quip/shared/deployment";

import { BunRunner } from "./bun-runner";

const APP_DIR = "/app";

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

function plan(): RunPlan {
  const dev = envFlag("DEV", false);
  // Each app owns its dev/start script; the workspace dir is the only thing
  // that differs between them.
  const command: readonly string[] = ["bun", "run", dev ? "dev" : "start"];

  const apps: Application[] = [];
  if (envFlag("RUN_SERVER", true))
    apps.push({ name: "server", command, cwd: `${APP_DIR}/apps/server` });
  if (envFlag("RUN_INDEXER", true))
    apps.push({ name: "indexer", command, cwd: `${APP_DIR}/apps/indexer` });
  // The SPA is static in prod (served by the server from STATIC_DIR); only the
  // dev image runs vite, so the frontend app is DEV-gated.
  if (dev && envFlag("RUN_FRONTEND", true))
    apps.push({ name: "frontend", command, cwd: `${APP_DIR}/apps/frontend` });

  const setup: SetupStep[] = [];
  // Dev installs against the bind-mounted source so node_modules tracks the host
  // checkout; prod images bake deps at build time and skip this.
  if (dev) setup.push({ label: "bun install (dev)", command: ["bun", "install"], cwd: APP_DIR });
  // Apply the Postgres schema before the server / indexer connect.
  setup.push({
    label: "running migrate",
    command: ["bun", "run", "migrate"],
    cwd: `${APP_DIR}/apps/server`,
  });

  return { setup, apps };
}

new BunRunner().run(plan()).then(
  (code) => process.exit(code),
  (err) => {
    console.error("entrypoint: fatal", err);
    process.exit(1);
  },
);
