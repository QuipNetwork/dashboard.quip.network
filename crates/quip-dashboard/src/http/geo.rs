// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offline city lookup for a node's public host, from a local city database
//! in the GeoIP2-City schema (DB-IP City Lite in the image, `MaxMind` in tests).
use dashboard_model::NodeLocation;
use maxminddb::Reader;
use serde::Deserialize;
use std::{collections::BTreeMap, net::IpAddr, path::Path, time::Duration};
use tokio::{sync::Mutex, time::Instant};

/// Host lookups remembered per process. Sized above the fleet so a 30-second
/// nodes-document rebuild never evicts live entries and repeats their DNS.
const CACHE_ENTRIES: usize = 4096;
const CACHE_TTL: Duration = Duration::from_secs(300);
const DNS_TIMEOUT: Duration = Duration::from_secs(1);

/// A city database plus a short-lived cache of host lookups.
pub struct GeoIp {
    reader: Option<Reader<Vec<u8>>>,
    cache: Mutex<BTreeMap<String, (Instant, Option<NodeLocation>)>>,
}

/// What `lookup` is willing to resolve.
#[derive(Debug, PartialEq, Eq)]
enum Candidate {
    Ip(IpAddr),
    Name(String),
}

/// Normalize an operator-published host and decide whether it may reach the
/// resolver: an IP literal, or a DNS name of valid labels with an alphabetic
/// top label. Anything else returns `None` before any lookup.
fn candidate(host: &str) -> Option<Candidate> {
    let host = host.trim().to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host).to_owned();
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(Candidate::Ip(ip.to_canonical()));
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    let valid = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    };
    if !labels.iter().all(|label| valid(label)) {
        return None;
    }
    // A top label must contain an ASCII letter, rejecting malformed addresses
    // and labels such as `1-2` while allowing punycode such as `xn--p1ai`.
    if !labels
        .last()
        .is_some_and(|label| label.bytes().any(|byte| byte.is_ascii_alphabetic()))
    {
        return None;
    }
    Some(Candidate::Name(host))
}

/// Whether an address can appear in a public geolocation database.
fn is_public(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            let shared = first == 100 && (64..=127).contains(&second);
            let benchmarking = first == 198 && (second & 0xfe) == 18;
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_documentation()
                || first == 0
                || first >= 240
                || benchmarking
                || shared)
        }
        IpAddr::V6(v6) => {
            let [first, second, third, ..] = v6.segments();
            let documentation = (first == 0x2001 && second == 0x0db8)
                || (first == 0x3fff && (second & 0xf000) == 0);
            let benchmarking = first == 0x2001 && second == 0x0002 && third == 0;
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || documentation
                || benchmarking)
        }
    }
}

/// Make a DNS name absolute without adding a second root dot.
fn absolute_name(name: &str) -> String {
    format!("{}.", name.strip_suffix('.').unwrap_or(name))
}

/// First address for a validated DNS name, or `None` on failure or timeout.
async fn resolve(name: &str) -> Option<IpAddr> {
    let query = absolute_name(name);
    match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((query.as_str(), 0))).await {
        Ok(Ok(mut addresses)) => addresses.next().map(|address| address.ip()),
        Ok(Err(error)) => {
            tracing::debug!(%error, host = name, "GeoIP DNS lookup failed");
            None
        }
        Err(_) => {
            tracing::debug!(host = name, "GeoIP DNS lookup timed out");
            None
        }
    }
}

/// The city record for a public address, or `None` when absent or undecodable.
fn decode(reader: &Reader<Vec<u8>>, ip: IpAddr) -> Option<CityRecord> {
    match reader
        .lookup(ip)
        .and_then(|result| result.decode::<CityRecord>())
    {
        Ok(record) => record,
        Err(error) => {
            tracing::warn!(%error, "GeoIP lookup failed");
            None
        }
    }
}

impl GeoIp {
    /// Open the database at `path`. A missing or unreadable file disables lookup.
    #[must_use]
    pub fn new(path: Option<&Path>) -> Self {
        let reader = path.and_then(|path| match Reader::open_readfile(path) {
            Ok(reader) => Some(reader),
            Err(error) => {
                tracing::warn!(%error,"local GeoIP database unavailable");
                None
            }
        });
        Self {
            reader,
            cache: Mutex::new(BTreeMap::new()),
        }
    }
    /// Resolve `host` to a city, or `None` without a database, a well-formed
    /// public address, or a matching record. Malformed hosts never reach DNS
    /// or the cache. Private addresses and DNS misses are cached as misses.
    pub async fn lookup(&self, host: &str) -> Option<NodeLocation> {
        let reader = self.reader.as_ref()?;
        let candidate = candidate(host)?;
        let key = match &candidate {
            Candidate::Ip(ip) => ip.to_string(),
            Candidate::Name(name) => name.clone(),
        };
        // Serial DNS lookup bounds concurrency and collapses repeated misses.
        let mut cache = self.cache.lock().await;
        cache.retain(|_, (expiry, _)| *expiry > Instant::now());
        if let Some((_, location)) = cache.get(&key) {
            return location.clone();
        }
        let ip = match candidate {
            Candidate::Ip(ip) => Some(ip),
            Candidate::Name(name) => resolve(&name).await,
        };
        let location = ip
            .filter(|ip| is_public(*ip))
            .and_then(|ip| decode(reader, ip))
            .and_then(CityRecord::project);
        if cache.len() >= CACHE_ENTRIES {
            let _ = cache.pop_first();
        }
        let _ = cache.insert(key, (Instant::now() + CACHE_TTL, location.clone()));
        location
    }
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct CityRecord {
    country: Country,
    registered_country: Country,
    city: Names,
    location: Location,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Country {
    iso_code: Option<String>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Names {
    names: BTreeMap<String, String>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Location {
    latitude: Option<f64>,
    longitude: Option<f64>,
}
impl CityRecord {
    fn project(self) -> Option<NodeLocation> {
        Some(NodeLocation {
            country: self
                .country
                .iso_code
                .or(self.registered_country.iso_code)
                .unwrap_or_else(|| "??".into()),
            city: self.city.names.get("en").cloned(),
            lat: self.location.latitude?,
            lng: self.location.longitude?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Candidate, GeoIp, absolute_name, candidate, is_public};
    use std::net::IpAddr;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn malformed_hosts_are_not_candidates() {
        let long = "a".repeat(254);
        for host in [
            "",
            " ",
            "y",
            "442.224.551",
            "-bad.example",
            "bad-.example",
            "a..b",
            "example.com..",
            "example.1-2",
            "ex ample.com",
            "under_score.example",
            long.as_str(),
        ] {
            assert_eq!(candidate(host), None, "{host:?}");
        }
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions compare parsed addresses while propagating parse failures"
    )]
    fn names_and_addresses_normalize() -> TestResult {
        assert_eq!(
            candidate(" Example.COM. "),
            Some(Candidate::Name("example.com".into()))
        );
        assert_eq!(
            candidate("example.xn--p1ai"),
            Some(Candidate::Name("example.xn--p1ai".into()))
        );
        assert_eq!(
            candidate("somewhere-example-vegetables-workshop.trycloudflare.com"),
            Some(Candidate::Name(
                "somewhere-example-vegetables-workshop.trycloudflare.com".into()
            ))
        );
        let v4: IpAddr = "89.160.20.128".parse()?;
        assert_eq!(candidate("89.160.20.128"), Some(Candidate::Ip(v4)));
        assert_eq!(candidate("::ffff:89.160.20.128"), Some(Candidate::Ip(v4)));
        let v6: IpAddr = "2001:218::1".parse()?;
        assert_eq!(candidate("2001:218::1"), Some(Candidate::Ip(v6)));
        Ok(())
    }

    #[test]
    fn dns_query_names_are_absolute() {
        assert_eq!(absolute_name("example.com"), "example.com.");
        assert_eq!(absolute_name("example.com."), "example.com.");
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions classify parsed addresses while propagating parse failures"
    )]
    fn private_and_reserved_addresses_are_not_public() -> TestResult {
        for ip in [
            "10.0.0.1",
            "172.16.5.5",
            "192.168.1.5",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "100.127.255.254",
            "0.0.0.0",
            "192.0.2.1",
            "255.255.255.255",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
            "3fff::1",
            "224.0.0.1",
            "0.0.0.1",
            "240.0.0.1",
            "198.18.0.1",
            "198.19.255.254",
            "ff02::1",
            "2001:2::1",
        ] {
            assert!(!is_public(ip.parse()?), "{ip} must not be public");
        }
        for ip in [
            "89.160.20.128",
            "8.8.8.8",
            "100.63.255.255",
            "2001:218::1",
            "198.17.255.254",
            "198.20.0.1",
            "223.255.255.254",
            "2001:3::1",
        ] {
            assert!(is_public(ip.parse()?), "{ip} must be public");
        }
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "The test asserts the resolver was skipped while propagating IO failures"
    )]
    async fn malformed_hosts_never_reach_the_resolver_or_the_cache() -> TestResult {
        let directory = tempfile::tempdir()?;
        let database = directory.path().join("city.mmdb");
        std::fs::write(&database, include_bytes!("testdata/GeoIP2-City-Test.mmdb"))?;
        let geo = GeoIp::new(Some(&database));
        for host in ["y", "442.224.551", "", "-bad.example"] {
            assert!(geo.lookup(host).await.is_none(), "{host:?}");
        }
        assert!(geo.cache.lock().await.is_empty());
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "The test asserts private addresses skip the database while propagating IO failures"
    )]
    async fn private_addresses_are_cached_misses_without_a_database_read() -> TestResult {
        let directory = tempfile::tempdir()?;
        let database = directory.path().join("city.mmdb");
        std::fs::write(&database, include_bytes!("testdata/GeoIP2-City-Test.mmdb"))?;
        let geo = GeoIp::new(Some(&database));
        assert!(geo.lookup("10.0.0.1").await.is_none());
        assert!(geo.lookup("fd00::1").await.is_none());
        assert_eq!(geo.cache.lock().await.len(), 2);
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "The integration test asserts decoded fixture values while propagating IO failures"
    )]
    async fn official_city_database_supplies_coordinates_and_caches_result() -> TestResult {
        let directory = tempfile::tempdir()?;
        let database = directory.path().join("city.mmdb");
        std::fs::write(&database, include_bytes!("testdata/GeoIP2-City-Test.mmdb"))?;
        let geo = GeoIp::new(Some(&database));
        let location = geo
            .lookup("89.160.20.128")
            .await
            .ok_or("fixture city absent")?;
        // Expected values are from MaxMind's source-data/GeoIP2-City-Test.json.
        assert_eq!(location.country, "SE");
        assert_eq!(location.city.as_deref(), Some("Linköping"));
        assert!((location.lat - 58.4167).abs() < f64::EPSILON);
        assert!((location.lng - 15.6167).abs() < f64::EPSILON);
        assert_eq!(geo.lookup("89.160.20.128").await, Some(location));
        assert_eq!(geo.cache.lock().await.len(), 1);
        assert!(geo.lookup("127.0.0.1").await.is_none());
        assert_eq!(geo.cache.lock().await.len(), 2);
        Ok(())
    }
}
