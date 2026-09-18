// SPDX-License-Identifier: AGPL-3.0-or-later
//! Dashboard persistence, serialized mutations, and transactional coverage.
mod backend;
mod blocks;
mod coverage;
mod inspection;
mod migrations;
mod miners;
mod store;
mod telemetry;
mod types;
pub use store::Store;
pub use types::*;

#[cfg(all(test, feature = "postgres"))]
mod read_only_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod api_budget_tests;
