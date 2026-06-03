// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  NodeDescriptor,
  NodeMinerEntry,
  NodeRuntime,
  NodeSystemInfo,
} from "../src/types/telemetry";

const SCHEMA_NAME = "quip.node_descriptor.v1";
const MAX_NODE_NAME_BYTES = 64;
const MAX_RPC_ENDPOINTS = 8;
const MAX_RPC_ENDPOINT_BYTES = 256;

// Credential-shape patterns. A descriptor that contains one of these is
// treated as a misconfigured upload (operator pasted a token into a
// log_level field, etc.) and dropped wholesale — partial display would
// surface the leak in the dashboard. Mirrors the client-side scrub in
// `shared.system_info.validate_descriptor`.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /DWAVE_API_KEY/i,
  /AKIA[0-9A-Z]{16}/, // AWS access key
  /\bASIA[0-9A-Z]{16}\b/, // AWS session key
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI-style secret keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /\bey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, // JWT (3-segment base64url)
];

/**
 * Parse a chain remark body and return a validated NodeDescriptor — or
 * a structured failure when any of the spec's "Discarded payloads" rules
 * fires. The caller logs the rejection reason for operator-actionable
 * diagnostics.
 *
 * Accepts either a UTF-8 string or raw Uint8Array (the chain hands us
 * `Bytes`, which the substrate client converts to a hex string upstream).
 */
export type ValidationResult =
  | { ok: true; descriptor: NodeDescriptor }
  | { ok: false; reason: string };

export function parseAndValidateDescriptor(rawBody: string | Uint8Array): ValidationResult {
  let text: string;
  try {
    text =
      typeof rawBody === "string"
        ? rawBody
        : new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return { ok: false, reason: "remark body is not valid UTF-8" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "remark body is not valid JSON" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "descriptor is not a JSON object" };
  }
  const p = parsed as Record<string, unknown>;

  if (p.schema !== SCHEMA_NAME) {
    return { ok: false, reason: `schema mismatch (got ${JSON.stringify(p.schema)})` };
  }
  const version = p.descriptor_version ?? p.descriptorVersion;
  if (version !== 1) {
    return { ok: false, reason: `unsupported descriptor_version (got ${JSON.stringify(version)})` };
  }

  // node_name: required, non-empty, ≤ 64 UTF-8 bytes.
  const nodeNameRaw = p.node_name ?? p.nodeName;
  if (typeof nodeNameRaw !== "string" || nodeNameRaw.length === 0) {
    return { ok: false, reason: "node_name is missing or empty" };
  }
  if (utf8ByteLength(nodeNameRaw) > MAX_NODE_NAME_BYTES) {
    return { ok: false, reason: `node_name exceeds ${MAX_NODE_NAME_BYTES} UTF-8 bytes` };
  }

  // rpc_endpoints: optional, ≤ 8 entries, each ≤ 256 UTF-8 bytes.
  const rpcEndpointsRaw = p.rpc_endpoints ?? p.rpcEndpoints;
  let rpcEndpoints: string[] | undefined;
  if (rpcEndpointsRaw !== undefined) {
    if (!Array.isArray(rpcEndpointsRaw)) {
      return { ok: false, reason: "rpc_endpoints must be an array" };
    }
    if (rpcEndpointsRaw.length > MAX_RPC_ENDPOINTS) {
      return { ok: false, reason: `rpc_endpoints exceeds ${MAX_RPC_ENDPOINTS} entries` };
    }
    const checked: string[] = [];
    for (const entry of rpcEndpointsRaw) {
      if (typeof entry !== "string") {
        return { ok: false, reason: "rpc_endpoints entries must be strings" };
      }
      if (utf8ByteLength(entry) > MAX_RPC_ENDPOINT_BYTES) {
        return { ok: false, reason: `rpc_endpoints entry exceeds ${MAX_RPC_ENDPOINT_BYTES} bytes` };
      }
      checked.push(entry);
    }
    rpcEndpoints = checked;
  }

  // Credential scrub on every string value in the parsed object. Cheap
  // for descriptors at this size (a few KB max).
  const leak = findCredentialLeak(p);
  if (leak) return { ok: false, reason: `descriptor carries credential-shaped string in ${leak}` };

  const descriptor: NodeDescriptor = {
    schema: SCHEMA_NAME,
    descriptorVersion: 1,
    nodeName: nodeNameRaw,
    publicHost: stringOrUndef(p.public_host ?? p.publicHost),
    publicPort: numberOrUndef(p.public_port ?? p.publicPort),
    rpcEndpoints,
    autoMine: boolOrUndef(p.auto_mine ?? p.autoMine),
    logLevel: stringOrUndef(p.log_level ?? p.logLevel),
    runtime: normaliseRuntime(p.runtime),
    miners: normaliseMiners(p.miners),
    systemInfo: normaliseSystemInfo(p.system_info ?? p.systemInfo),
  };
  return { ok: true, descriptor };
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolOrUndef(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function normaliseRuntime(v: unknown): NodeRuntime | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const out: NodeRuntime = {
    python: stringOrUndef(r.python),
    quipVersion: stringOrUndef(r.quip_version ?? r.quipVersion),
    protocolVersion: numberOrUndef(r.protocol_version ?? r.protocolVersion),
    inDocker: boolOrUndef(r.in_docker ?? r.inDocker),
    dockerImage: stringOrUndef(r.docker_image ?? r.dockerImage),
  };
  return out;
}

function normaliseMiners(v: unknown): Record<string, NodeMinerEntry> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, NodeMinerEntry> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kindRaw = stringOrUndef(r.kind);
    if (kindRaw !== "CPU" && kindRaw !== "GPU" && kindRaw !== "QPU" && kindRaw !== "OTHER")
      continue;
    const minerId = stringOrUndef(r.miner_id ?? r.minerId);
    if (!minerId) continue;
    out[key] = {
      kind: kindRaw,
      minerId,
      numCpus: numberOrUndef(r.num_cpus ?? r.numCpus),
      backend: stringOrUndef(r.backend),
      deviceIndex: numberOrUndef(r.device_index ?? r.deviceIndex),
      utilization: numberOrUndef(r.utilization),
      provider: stringOrUndef(r.provider),
      solver: stringOrUndef(r.solver),
      dailyBudget: stringOrUndef(r.daily_budget ?? r.dailyBudget),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normaliseSystemInfo(v: unknown): NodeSystemInfo | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const osRaw = r.os as Record<string, unknown> | undefined;
  const cpuRaw = r.cpu as Record<string, unknown> | undefined;
  // `gpus`, if present, must be an array. Non-array (e.g. operator wrote
  // `"gpus": "n/a"`) is a malformed payload — treat as no GPUs rather than
  // throw on `.map`, which would stall the descriptor worker on the bad
  // remark forever.
  const gpusCandidate = r.gpus;
  const gpusRaw: unknown[] = Array.isArray(gpusCandidate) ? gpusCandidate : [];
  return {
    os: osRaw
      ? {
          system: stringOrUndef(osRaw.system),
          release: stringOrUndef(osRaw.release),
          machine: stringOrUndef(osRaw.machine),
        }
      : undefined,
    cpu: cpuRaw
      ? {
          logicalCores: numberOrUndef(cpuRaw.logical_cores ?? cpuRaw.logicalCores),
          physicalCores: numberOrUndef(cpuRaw.physical_cores ?? cpuRaw.physicalCores),
          brand: stringOrUndef(cpuRaw.brand),
          arch: stringOrUndef(cpuRaw.arch),
        }
      : undefined,
    memoryMb: numberOrUndef(r.memory_mb ?? r.memoryMb),
    gpus: gpusRaw
      .map((g) => {
        if (!g || typeof g !== "object") return null;
        const gr = g as Record<string, unknown>;
        return {
          index: numberOrUndef(gr.index),
          vendor: stringOrUndef(gr.vendor),
          name: stringOrUndef(gr.name),
          memoryMb: numberOrUndef(gr.memory_mb ?? gr.memoryMb),
          observedUtilizationPct: numberOrUndef(
            gr.observed_utilization_pct ?? gr.observedUtilizationPct,
          ),
        };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null),
  };
}

/**
 * Walk the parsed payload looking for credential-shaped strings. Returns
 * the dotted path of the offending key (e.g. `"runtime.docker_image"`)
 * or null when clean. Recurses into nested objects/arrays but caps depth
 * to avoid pathological payloads.
 */
function findCredentialLeak(root: unknown, path = "", depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof root === "string") {
    for (const re of CREDENTIAL_PATTERNS) {
      if (re.test(root)) return path || "(root)";
    }
    return null;
  }
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      const hit = findCredentialLeak(root[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (root && typeof root === "object") {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      const hit = findCredentialLeak(v, childPath, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
