// SPDX-License-Identifier: AGPL-3.0-or-later
//! Offline city lookup for a node's public host, from a local `MaxMind` database.
use dashboard_model::NodeLocation;
use maxminddb::Reader;
use serde::Deserialize;
use std::{collections::BTreeMap, net::IpAddr, path::Path, time::Duration};
use tokio::{sync::Mutex, time::Instant};

/// A city database plus a short-lived cache of host lookups.
pub struct GeoIp {
    reader: Option<Reader<Vec<u8>>>,
    cache: Mutex<BTreeMap<String, (Instant, Option<NodeLocation>)>>,
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
    /// Resolve `host` to a city, or `None` without a database, a resolvable
    /// address, or a matching record.
    pub async fn lookup(&self, host: &str) -> Option<NodeLocation> {
        let reader = self.reader.as_ref()?;
        if host.len() > 253 {
            return None;
        }
        let host = host.to_ascii_lowercase();
        // Serial DNS lookup bounds concurrency and collapses repeated misses.
        let mut cache = self.cache.lock().await;
        cache.retain(|_, (expiry, _)| *expiry > Instant::now());
        if let Some((_, location)) = cache.get(&host) {
            return location.clone();
        }
        let ip = match host.parse::<IpAddr>() {
            Ok(ip) => Some(ip),
            Err(_) => match tokio::time::timeout(
                Duration::from_secs(1),
                tokio::net::lookup_host((host.as_str(), 0)),
            )
            .await
            {
                Ok(Ok(mut addresses)) => addresses.next().map(|address| address.ip()),
                Ok(Err(error)) => {
                    tracing::debug!(%error,"GeoIP DNS lookup failed");
                    None
                }
                Err(_) => {
                    tracing::debug!("GeoIP DNS lookup timed out");
                    None
                }
            },
        };
        let location = ip.and_then(|ip| {
            match reader
                .lookup(ip)
                .and_then(|result| result.decode::<CityRecord>())
            {
                Ok(Some(city)) => city.project(),
                Ok(None) => None,
                Err(error) => {
                    tracing::warn!(%error,"GeoIP lookup failed");
                    None
                }
            }
        });
        if cache.len() >= 256 {
            let _ = cache.pop_first();
        }
        let _ = cache.insert(
            host,
            (Instant::now() + Duration::from_secs(300), location.clone()),
        );
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
    use super::GeoIp;

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "The integration test asserts decoded fixture values while propagating IO failures"
    )]
    async fn official_city_database_supplies_coordinates_and_caches_result()
    -> Result<(), Box<dyn std::error::Error>> {
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
