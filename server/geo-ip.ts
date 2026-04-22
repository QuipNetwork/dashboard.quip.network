// SPDX-License-Identifier: AGPL-3.0-or-later

// Geo-IP lookup for node publicHost values.
//
// Default backend: `geoip-lite` npm package, which bundles a copy of the
// MaxMind GeoLite2-City database (~100MB) with the package — zero operator
// setup, offline, fast. The bundled data refreshes when the package is
// bumped.
//
// Override: when GEOIP_DB_PATH is set, we open that .mmdb via the `maxmind`
// package instead. Useful for operators who keep their own refreshed
// GeoLite2-City or GeoIP2-City (commercial) database on disk.
//
// Both paths cache per-hostname results for one hour to avoid re-resolving
// DNS on every /api/telemetry hit.

import { lookup as dnsLookup } from "node:dns/promises";

import type { CityResponse, Reader } from "mmdb-lib";

import type { NodeInfo, NodeLocation } from "../src/types/telemetry";

const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  location: NodeLocation | null;
  expiresAt: number;
}

export interface GeoIpEnricher {
  enrich(node: NodeInfo): Promise<NodeInfo>;
  enrichSnapshot(nodes: Record<string, NodeInfo>): Promise<Record<string, NodeInfo>>;
  readonly enabled: boolean;
}

class NoopEnricher implements GeoIpEnricher {
  readonly enabled = false;
  async enrich(node: NodeInfo): Promise<NodeInfo> {
    return node;
  }
  async enrichSnapshot(nodes: Record<string, NodeInfo>): Promise<Record<string, NodeInfo>> {
    return nodes;
  }
}

// Resolver shape — abstracts over geoip-lite (sync) and maxmind (sync .get()).
type IpResolver = (ip: string) => NodeLocation | null;

class CachingEnricher implements GeoIpEnricher {
  readonly enabled = true;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly resolve: IpResolver) {}

  async enrich(node: NodeInfo): Promise<NodeInfo> {
    if (!node.publicHost) return node;
    const location = await this.lookupWithCache(node.publicHost);
    if (!location) return node;
    return { ...node, location };
  }

  async enrichSnapshot(nodes: Record<string, NodeInfo>): Promise<Record<string, NodeInfo>> {
    const entries = await Promise.all(
      Object.entries(nodes).map(async ([addr, info]) => [addr, await this.enrich(info)] as const),
    );
    return Object.fromEntries(entries);
  }

  private async lookupWithCache(host: string): Promise<NodeLocation | null> {
    const key = host.toLowerCase();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.location;

    let ip: string;
    try {
      const r = await dnsLookup(host);
      ip = r.address;
    } catch {
      this.cache.set(key, { location: null, expiresAt: now + CACHE_TTL_MS });
      return null;
    }

    const location = this.resolve(ip);
    this.cache.set(key, { location, expiresAt: now + CACHE_TTL_MS });
    return location;
  }
}

function maxmindResolver(reader: Reader<CityResponse>): IpResolver {
  return (ip) => {
    const record = reader.get(ip);
    if (!record) return null;
    const lat = record.location?.latitude;
    const lng = record.location?.longitude;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    const country = record.country?.iso_code ?? record.registered_country?.iso_code ?? "??";
    const city = record.city?.names.en;
    return city ? { country, city, lat, lng } : { country, lat, lng };
  };
}

// Shape returned by geoip-lite's lookup() — typed conservatively since the
// @types/geoip-lite declaration covers the common fields we need.
interface GeoLiteLookup {
  country: string;
  city?: string;
  ll: [number, number];
}

function geoLiteResolver(lookup: (ip: string) => GeoLiteLookup | null): IpResolver {
  return (ip) => {
    const record = lookup(ip);
    if (!record || !Array.isArray(record.ll)) return null;
    const [lat, lng] = record.ll;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    const country = record.country || "??";
    const city = record.city && record.city.length > 0 ? record.city : undefined;
    return city ? { country, city, lat, lng } : { country, lat, lng };
  };
}

let singleton: GeoIpEnricher | null = null;

export async function getGeoIpEnricher(): Promise<GeoIpEnricher> {
  if (singleton) return singleton;
  const dbPath = process.env.GEOIP_DB_PATH;
  if (dbPath) {
    try {
      const { open } = await import("maxmind");
      const reader = await open<CityResponse>(dbPath);
      console.log(`[geoip] using maxmind reader from ${dbPath}`);
      singleton = new CachingEnricher(maxmindResolver(reader));
      return singleton;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[geoip] failed to open ${dbPath}: ${msg}; falling back to geoip-lite`);
    }
  }
  try {
    // geoip-lite's `lookup` is synchronous; it loads its bundled .dat files
    // into memory on first call. The data ships with the package so there is
    // no external fetch or license setup.
    const mod = (await import("geoip-lite")) as unknown as {
      default?: { lookup: (ip: string) => GeoLiteLookup | null };
      lookup?: (ip: string) => GeoLiteLookup | null;
    };
    const lookup = mod.lookup ?? mod.default?.lookup;
    if (!lookup) throw new Error("geoip-lite has no lookup export");
    console.log("[geoip] using bundled geoip-lite database");
    singleton = new CachingEnricher(geoLiteResolver(lookup));
    return singleton;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[geoip] could not load geoip-lite: ${msg}; map will show no markers`);
    singleton = new NoopEnricher();
    return singleton;
  }
}

export function _setEnricherForTesting(next: GeoIpEnricher | null): void {
  singleton = next;
}
