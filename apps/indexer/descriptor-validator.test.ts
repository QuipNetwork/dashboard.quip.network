// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { parseAndValidateDescriptor } from "./descriptor-validator";

// Minimal valid payload — used as the base for negative tests below.
const VALID = {
  schema: "quip.node_descriptor.v1",
  descriptor_version: 1,
  node_name: "rig-01",
  public_host: "rig-01.example.com",
  public_port: 20049,
  rpc_endpoints: ["ws://rig-01.example.com:9944"],
  auto_mine: true,
  log_level: "INFO",
  runtime: {
    python: "3.13.13",
    quip_version: "0.2.0",
    protocol_version: 2,
    in_docker: true,
    docker_image: "registry.gitlab.com/quip.network/quip-protocol/quip-network-node-cpu:abc1234",
  },
  miners: {
    cpu: { kind: "CPU", miner_id: "rig-01-CPU-1", num_cpus: 2 },
    dwave: {
      kind: "QPU",
      miner_id: "rig-01-QPU-DWAVE-1",
      provider: "dwave",
      solver: "Advantage2_system1",
      daily_budget: "5m",
    },
  },
  system_info: {
    os: { system: "Linux", release: "5.15.0", machine: "x86_64" },
    cpu: { logical_cores: 32, physical_cores: 16, brand: "AMD Ryzen 9 5950X", arch: "x86_64" },
    memory_mb: 128693,
    gpus: [{ index: 0, vendor: "NVIDIA", name: "RTX A4000", memory_mb: 16376 }],
  },
};

const validJson = (override: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...VALID, ...override });

describe("parseAndValidateDescriptor", () => {
  it("accepts the canonical PDF payload and normalises snake_case to camelCase", () => {
    const result = parseAndValidateDescriptor(validJson());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.nodeName).toBe("rig-01");
    expect(result.descriptor.runtime?.quipVersion).toBe("0.2.0");
    expect(result.descriptor.miners?.cpu?.kind).toBe("CPU");
    expect(result.descriptor.systemInfo?.gpus?.[0]?.memoryMb).toBe(16376);
  });

  it("rejects non-UTF-8 bodies", () => {
    // 0xFF is invalid as a UTF-8 lead byte.
    const result = parseAndValidateDescriptor(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/UTF-8/);
  });

  it("rejects malformed JSON", () => {
    const result = parseAndValidateDescriptor("{not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/JSON/);
  });

  it("rejects wrong schema", () => {
    const result = parseAndValidateDescriptor(validJson({ schema: "other.v1" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/schema/i);
  });

  it("rejects unsupported descriptor_version", () => {
    const result = parseAndValidateDescriptor(validJson({ descriptor_version: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/descriptor_version/i);
  });

  it("rejects empty node_name", () => {
    const result = parseAndValidateDescriptor(validJson({ node_name: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/node_name/i);
  });

  it("rejects node_name > 64 UTF-8 bytes", () => {
    const longName = "a".repeat(65);
    const result = parseAndValidateDescriptor(validJson({ node_name: longName }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/64/);
  });

  it("counts node_name bytes, not codepoints", () => {
    // Each emoji is 4 bytes in UTF-8 — 17 emojis = 68 bytes (> 64).
    const result = parseAndValidateDescriptor(validJson({ node_name: "🚀".repeat(17) }));
    expect(result.ok).toBe(false);
  });

  it("rejects > 8 rpc_endpoints", () => {
    const endpoints = Array.from({ length: 9 }, (_, i) => `ws://h${i}:9944`);
    const result = parseAndValidateDescriptor(validJson({ rpc_endpoints: endpoints }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/rpc_endpoints/i);
  });

  it("rejects rpc_endpoints entries > 256 bytes", () => {
    const huge = "ws://" + "x".repeat(300);
    const result = parseAndValidateDescriptor(validJson({ rpc_endpoints: [huge] }));
    expect(result.ok).toBe(false);
  });

  it("rejects credential-shaped values (Bearer)", () => {
    const result = parseAndValidateDescriptor(
      validJson({ log_level: "Bearer eyJabc123def456ghi789jklmnop" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/credential/i);
  });

  it("rejects credential-shaped values nested in runtime", () => {
    const result = parseAndValidateDescriptor(
      validJson({
        runtime: { ...VALID.runtime, docker_image: "secret-AKIAABCDEFGHIJKLMNOP-leak" },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("drops miners entries with invalid kinds rather than rejecting the whole descriptor", () => {
    const result = parseAndValidateDescriptor(
      validJson({
        miners: {
          cpu: { kind: "CPU", miner_id: "good" },
          bogus: { kind: "WHATEVER", miner_id: "bad" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.descriptor.miners ?? {})).toEqual(["cpu"]);
  });

  it("returns undefined runtime when payload has no runtime field", () => {
    const result = parseAndValidateDescriptor(
      JSON.stringify({
        schema: "quip.node_descriptor.v1",
        descriptor_version: 1,
        node_name: "rig-01",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.descriptor.runtime).toBeUndefined();
    expect(result.descriptor.miners).toBeUndefined();
  });
});
