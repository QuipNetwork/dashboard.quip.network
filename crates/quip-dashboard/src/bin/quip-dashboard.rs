// SPDX-License-Identifier: AGPL-3.0-or-later
//! Dashboard service and explicit offline administration commands.
use clap::{Parser, Subcommand, ValueEnum};
use dashboard_model::DecimalString;
use dashboard_store::{Indexable, Store};
use quip_dashboard::{config::Config, lifecycle};
use std::{
    error::Error,
    io::{self, Write},
    process::ExitCode,
    sync::Arc,
    time::Duration,
};

type CommandResult = Result<(), Box<dyn Error + Send + Sync>>;

#[derive(Parser)]
#[command(version, about = "Quip dashboard service and storage administration")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Run HTTP, indexing, miner polling, and the watchdog.
    Serve,
    /// Apply additive local migrations without contacting a validator.
    Migrate {
        #[arg(value_enum)]
        action: Option<MigrationAction>,
        #[arg(long, conflicts_with = "action")]
        dry_run: bool,
    },
    /// List the four block domains and persisted generation/coverage state.
    ListIndexables,
    /// Drop owned history for these domains (no arguments selects all four).
    Reindex {
        #[arg(value_enum, value_delimiter = ',')]
        domains: Vec<Domain>,
    },
    /// Reconstruct earliest descriptor timestamps from historical chain state.
    ReconstructFirstseen,
    /// Query the running process liveness endpoint; never opens the database.
    Healthcheck {
        /// Local backend base URL. PORT selects the default loopback port.
        #[arg(long)]
        url: Option<String>,
    },
}
#[derive(Clone, Copy, ValueEnum)]
enum MigrationAction {
    #[value(alias = "migrate")]
    Up,
    Status,
    #[value(alias = "plan")]
    DryRun,
}
#[derive(Clone, Copy, ValueEnum)]
enum Domain {
    Winners,
    Difficulty,
    Participation,
    Authorship,
}
impl From<Domain> for Indexable {
    fn from(domain: Domain) -> Self {
        match domain {
            Domain::Winners => Self::Winners,
            Domain::Difficulty => Self::Difficulty,
            Domain::Participation => Self::Participation,
            Domain::Authorship => Self::Authorship,
        }
    }
}
const DOMAINS: [Indexable; 4] = [
    Indexable::Winners,
    Indexable::Difficulty,
    Indexable::Participation,
    Indexable::Authorship,
];

fn main() -> ExitCode {
    let cli = Cli::parse();
    let _ = tracing_subscriber::fmt().with_writer(io::stderr).try_init();
    let result = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let result = runtime.block_on(execute(cli.command));
            // Tasks and storage already drained under the shared deadline. Runtime drop must not wait indefinitely for a CPU decoder.
            runtime.shutdown_timeout(Duration::ZERO);
            result
        }
        Err(error) => Err(error.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "{error}");
            ExitCode::FAILURE
        }
    }
}
async fn execute(command: Command) -> CommandResult {
    if let Command::Healthcheck { url } = command {
        return healthcheck(url).await;
    }
    let config = Config::from_env()?;
    if let Command::Serve = command {
        return serve(config).await;
    }
    if let Command::Migrate { action, dry_run } = &command {
        let action = if *dry_run {
            MigrationAction::DryRun
        } else {
            action.unwrap_or(MigrationAction::Up)
        };
        match action {
            MigrationAction::Status | MigrationAction::DryRun => {
                let rows = Store::inspect_migrations(store_config(&config)).await?;
                return show_migration_plan(action, &rows);
            }
            MigrationAction::Up => {}
        }
    }
    let store = Arc::new(Store::open(store_config(&config)).await?);
    let result = administer(command, &config, store.clone()).await;
    let closed = close_store(store).await;
    result.and(closed)
}
async fn administer(command: Command, config: &Config, store: Arc<Store>) -> CommandResult {
    match command {
        Command::Migrate { .. } => {
            for migration in store.migration_status().await? {
                writeln!(
                    io::stdout().lock(),
                    "{} {}",
                    migration.name,
                    migration.executed_at.as_deref().unwrap_or("pending")
                )?;
            }
        }
        Command::ListIndexables => {
            for domain in DOMAINS {
                let generation = store.generation(domain).await?;
                let coverage = store.coverage(domain).await?;
                let summary = coverage.map_or_else(
                    || "coverage: (none)".into(),
                    |coverage| {
                        format!(
                            "coverage: low={} high={} gaps={} prunedFloor={} gen={}",
                            coverage
                                .low
                                .map_or_else(|| "-".into(), |height| height.to_string()),
                            coverage
                                .high
                                .map_or_else(|| "-".into(), |height| height.to_string()),
                            coverage.gaps.len(),
                            coverage
                                .pruned_floor
                                .map_or_else(|| "-".into(), |height| height.to_string()),
                            coverage.r#gen
                        )
                    },
                );
                writeln!(
                    io::stdout().lock(),
                    "block     {:18} gen={generation} {summary}",
                    domain.name()
                )?;
            }
        }
        Command::Reindex { domains } => {
            let domains = if domains.is_empty() {
                DOMAINS.to_vec()
            } else {
                domains.into_iter().map(Into::into).collect()
            };
            for changed in store.reindex(&domains).await? {
                writeln!(
                    io::stdout().lock(),
                    "reindex: dropped state for \"{}\" (generation {})",
                    changed.indexable.name(),
                    changed.expected
                )?;
            }
        }
        Command::ReconstructFirstseen => {
            let chain = connect_and_bind(config, &store, None).await?;
            let (indexer, _) = quip_dashboard::indexer::Indexer::new(store, chain.clone());
            let reconstructed = indexer.reconstruct_first_seen().await;
            let disconnected = chain.disconnect().await;
            let count = reconstructed?;
            disconnected?;
            writeln!(
                io::stdout().lock(),
                "reconstructed first-seen records: {count}"
            )?;
        }
        Command::Serve | Command::Healthcheck { .. } => {
            return Err("command must run before opening administrative storage".into());
        }
    }
    Ok(())
}
async fn healthcheck(url: Option<String>) -> CommandResult {
    let base = if let Some(url) = url {
        url
    } else {
        let port = std::env::var("PORT")
            .ok()
            .map(|port| port.parse::<u16>())
            .transpose()?
            .unwrap_or(3001);
        format!("http://127.0.0.1:{port}")
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()?;
    let status = client
        .get(format!("{}/api/live", base.trim_end_matches('/')))
        .send()
        .await?
        .status();
    if status != reqwest::StatusCode::OK {
        return Err(format!("backend liveness returned HTTP {status}").into());
    }
    Ok(())
}

fn store_config(config: &Config) -> dashboard_store::StoreConfig {
    match &config.database {
        quip_dashboard::config::DatabaseBackend::Turso { path } => {
            dashboard_store::StoreConfig::Turso { path: path.clone() }
        }
        quip_dashboard::config::DatabaseBackend::Postgres {
            url,
            max_connections,
        } => dashboard_store::StoreConfig::Postgres {
            url: url.as_str().into(),
            max_connections: *max_connections,
        },
    }
}
async fn close_store(store: Arc<Store>) -> CommandResult {
    let store =
        Arc::try_unwrap(store).map_err(|_| "database still has active owners after task drain")?;
    store.close().await?;
    Ok(())
}
async fn connect_and_bind(
    config: &Config,
    store: &Arc<Store>,
    health: Option<&quip_dashboard::health::HealthState>,
) -> Result<Arc<quip_dashboard::chain::ChainReader>, Box<dyn Error + Send + Sync>> {
    use quip_dashboard::chain::{BlockHash, ChainReader, WorkClass};
    let bound = store.bound_genesis().await?;
    let mut last_error: Box<dyn Error + Send + Sync> = "no validator endpoints configured".into();
    for endpoint in &config.validator_rpc_urls {
        let genesis = if let Some(genesis) = &bound {
            BlockHash(*genesis.as_bytes())
        } else {
            match ChainReader::discover_genesis(endpoint.as_str()).await {
                Ok(genesis) => genesis,
                Err(error) => {
                    last_error = error.into();
                    continue;
                }
            }
        };
        let chain = Arc::new(ChainReader::new(endpoint.as_str(), genesis));
        if let Err(error) = chain.connect().await {
            if let quip_dashboard::chain::ChainError::GenesisMismatch { .. } = error {
                return Err(error.into());
            }
            last_error = error.into();
            continue;
        }
        if let Some(health) = health {
            health.set_phase(quip_dashboard::health::Phase::Verifying);
        }
        let result = store
            .bind_network_with(&dashboard_model::BlockHash::from(genesis.0), |retained| {
                let chain = chain.clone();
                async move {
                    let height = retained
                        .height
                        .to_string()
                        .parse::<u64>()
                        .map_err(|error| dashboard_store::StoreError::Invalid(error.to_string()))?;
                    let hash = chain
                        .block_hash(height, WorkClass::Live)
                        .await
                        .map_err(|error| {
                            dashboard_store::StoreError::VerificationUnavailable(error.to_string())
                        })?
                        .ok_or(dashboard_store::StoreError::NetworkIdentity)?;
                    Ok(dashboard_model::BlockHash::from(hash.0))
                }
            })
            .await;
        match result {
            Ok(()) => return Ok(chain),
            Err(error) => {
                chain.disconnect().await?;
                return Err(error.into());
            }
        }
    }
    Err(last_error)
}

fn show_migration_plan(
    action: MigrationAction,
    rows: &[dashboard_store::MigrationStatusRow],
) -> CommandResult {
    let mut output = io::stdout().lock();
    for row in rows {
        match action {
            MigrationAction::Status => {
                let mark = if row.executed_at.is_some() {
                    "applied"
                } else {
                    "pending"
                };
                writeln!(
                    output,
                    "[{mark}] {} {}",
                    row.name,
                    row.executed_at.as_deref().unwrap_or("")
                )?;
            }
            MigrationAction::DryRun => {
                if row.executed_at.is_none() {
                    writeln!(output, "+ {}", row.name)?;
                }
            }
            MigrationAction::Up => return Err("migration up requires opening the writer".into()),
        }
    }
    Ok(())
}

struct StorePeers(Arc<Store>);
impl quip_dashboard::miner::PeerResolver for StorePeers {
    fn resolve<'a>(
        &'a self,
        account: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn Future<
                    Output = Result<
                        Option<quip_dashboard::miner::parse::PeerHost>,
                        quip_dashboard::miner::parse::MinerError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let descriptor = self.0.get_node_descriptor(account).await.map_err(|error| {
                quip_dashboard::miner::parse::MinerError::Unreachable(format!(
                    "stored peer descriptor: {error}"
                ))
            })?;
            Ok(
                descriptor.map(|row| quip_dashboard::miner::parse::PeerHost {
                    public_host: row.descriptor.public_host,
                    public_port: row.descriptor.public_port,
                }),
            )
        })
    }
}

type SharedChain = Arc<tokio::sync::Mutex<Option<Arc<quip_dashboard::chain::ChainReader>>>>;

async fn run_indexer(
    config: Arc<Config>,
    store: Arc<Store>,
    health: quip_dashboard::health::HealthState,
    bound: tokio::sync::watch::Sender<bool>,
    chain_slot: SharedChain,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    use quip_dashboard::{health::Phase, indexer::Indexer};
    let mut delay = Duration::from_secs(1);
    let chain = loop {
        health.set_phase(Phase::Connecting);
        let attempt = tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            attempt = connect_and_bind(&config, &store, Some(&health)) => attempt,
        };
        match attempt {
            Ok(chain) => break chain,
            Err(error) => {
                if permanent_identity_error(error.as_ref()) {
                    return Err(error.to_string());
                }
                tracing::warn!(
                    "validator connection or history verification unavailable; retrying"
                );
            }
        }
        tokio::select! { () = cancellation.cancelled() => return Ok(()), () = tokio::time::sleep(delay) => {} }
        delay = (delay * 2).min(Duration::from_secs(30));
    };
    *chain_slot.lock().await = Some(chain.clone());
    let _ = bound.send_replace(true);
    health.set_phase(Phase::Ready);
    // Restore the one-shot device-access-time backfill decision at startup,
    // before the indexer workers begin indexing (mirrors the prior TypeScript
    // one-shot). The decision surfaces as `deviceAccessTimeBackfill` on the API.
    if let Err(error) = lifecycle::ensure_device_access_time_backfill(&store).await {
        tracing::warn!(%error, "device-access-time backfill startup check failed");
        return Err(error.to_string());
    }
    let (indexer, mut progress) = Indexer::with_writer(
        store,
        chain,
        Some(quip_dashboard::indexer::file_writer::FileWriter::new(
            config.data_dir.clone(),
        )),
    );
    let monitor = async {
        let mut prior = quip_dashboard::indexer::Progress::default();
        loop {
            progress
                .changed()
                .await
                .map_err(|_| "indexer progress channel closed".to_owned())?;
            let current = progress.borrow_and_update().clone();
            health.connected(current.connected);
            if current.best_height != prior.best_height
                || current.finalized_height != prior.finalized_height
            {
                health.head_received(current.best_height, current.finalized_height);
            }
            if current.committed_height != prior.committed_height
                && let Some(height) = current.committed_height
            {
                health.committed(height);
            }
            prior = current;
        }
        #[expect(
            unreachable_code,
            reason = "progress observation runs until the worker or channel exits"
        )]
        Ok::<(), String>(())
    };
    let result = tokio::select! {
        result = indexer.run(cancellation.clone()) => result.map_err(|error| error.to_string()),
        result = monitor => result,
    };
    health.connected(false);
    result
}

fn permanent_identity_error(error: &(dyn Error + Send + Sync + 'static)) -> bool {
    if let Some(error) = error.downcast_ref::<dashboard_store::StoreError>() {
        return !matches!(
            error,
            dashboard_store::StoreError::VerificationUnavailable(_)
        );
    }
    if let Some(error) = error.downcast_ref::<quip_dashboard::chain::ChainError>() {
        return !matches!(
            error,
            quip_dashboard::chain::ChainError::Unavailable(_)
                | quip_dashboard::chain::ChainError::Disconnected
                | quip_dashboard::chain::ChainError::Busy
        );
    }
    true
}

async fn poll_miner(
    store: Arc<Store>,
    miner: Arc<quip_dashboard::miner::MinerService>,
    health: quip_dashboard::health::HealthState,
    bound: tokio::sync::watch::Receiver<bool>,
    interval: Duration,
    chain_slot: SharedChain,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    let mut ticks = tokio::time::interval(interval);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! { () = cancellation.cancelled() => return Ok(()), _ = ticks.tick() => {} }
        let iteration = async {
            let snapshot = miner.local_snapshot().await;
            if let Ok(status) = &snapshot.status {
                health.miner_success(&status.observed_at);
            }
            if let Err(error) = &snapshot.status {
                tracing::warn!(%error, "local miner status unavailable");
            }
            if let Err(error) = &snapshot.stats {
                tracing::warn!(%error, "local miner stats unavailable");
            }
            if !*bound.borrow() {
                return Ok(());
            }
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let identity = lifecycle::persist_miner_poll(
                &store,
                snapshot.status.as_ref().ok().map(|value| &value.data),
                snapshot.stats.as_ref().ok().map(|value| &value.data),
                &now,
            )
            .await?;
            if let Some(mut observability) = store.get_indexer_observability().await? {
                let snapshot = health.snapshot();
                observability.chain_connected = snapshot.chain_connected;
                observability.last_substrate_event_at = snapshot.last_substrate_event_at;
                observability.last_block_insert_at = snapshot.last_block_insert_at;
                observability.best_block_height = snapshot
                    .best_block_height
                    .map(|height| height.parse())
                    .transpose()?;
                observability.finalized_block_height = snapshot
                    .finalized_block_height
                    .map(|height| height.parse())
                    .transpose()?;
                // Surface validator node-sync observations so the frontend can show
                // the node-sync stage and gate cop-over semantics on a syncing node.
                if let Some(chain) = chain_slot.lock().await.as_ref() {
                    match chain.sync_state().await {
                        Ok(sync) => {
                            observability.node_syncing = Some(sync.is_syncing);
                            observability.node_sync_current_block =
                                Some(sync.current_block.map(DecimalString::from));
                            observability.node_sync_highest_block =
                                Some(sync.highest_block.map(DecimalString::from));
                        }
                        Err(error) => {
                            tracing::debug!(%error, "node sync state unavailable");
                        }
                    }
                }
                // The serial backfill worker has no in-memory queue. Pending work lives in durable coverage gaps.
                observability.indexer = Some(lifecycle::coverage_progress(&store, 0).await?);
                store.set_indexer_observability(&observability).await?;
            }
            if let Some(account) = identity
                && let Some(highest) = store
                    .get_chain_head()
                    .await?
                    .and_then(|head| head.qblock_count)
            {
                for solution in lifecycle::mining_catchup_range(&store, &account, highest).await? {
                    let attempt = miner
                        .local_attempts(solution)
                        .await
                        .map(|value| value.data.submission.clone());
                    match lifecycle::persist_mining_attempt(
                        &store, &account, solution, &now, attempt,
                    )
                    .await
                    {
                        Ok(()) => {}
                        Err(lifecycle::MinerPersistenceError::Store(error)) => {
                            return Err(error.into());
                        }
                        Err(error) => {
                            tracing::warn!(%error, "miner catch-up paused at current checkpoint");
                            break;
                        }
                    }
                }
            }
            Ok::<(), Box<dyn Error + Send + Sync>>(())
        };
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            result = iteration => result.map_err(|error| error.to_string())?,
        }
    }
}

async fn open_service_store(config: &Config) -> Result<Store, dashboard_store::StoreError> {
    if config.is_api_only() {
        let quip_dashboard::config::DatabaseBackend::Postgres {
            url,
            max_connections,
        } = &config.database
        else {
            return Err(dashboard_store::StoreError::Invalid(
                "API-only service requires Postgres".into(),
            ));
        };
        Store::open_read_only_postgres(url.as_str(), *max_connections).await
    } else {
        Store::open(store_config(config)).await
    }
}

async fn watchdog(
    health: quip_dashboard::health::HealthState,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            () = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
        if !health.snapshot().live {
            return Err("required task liveness failed".into());
        }
        health.heartbeat(quip_dashboard::health::RequiredTask::Watchdog);
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "Assembly keeps required tasks, shared ownership and final cleanup in one visible scope"
)]
async fn serve(config: Config) -> CommandResult {
    use quip_dashboard::{
        health::{HealthState, Phase, RequiredTask},
        http::{HttpState, router},
        miner::MinerService,
    };
    let health = HealthState::new(config.run_indexer);
    let store = tokio::select! {
        result = lifecycle::shutdown_signal() => { result?; return Ok(()); }
        result = tokio::time::timeout(Duration::from_secs(config.limits.startup_deadline_sec), open_service_store(&config)) => Arc::new(result.map_err(|_| "database startup exceeded 60 seconds")??),
    };
    let setup = async {
        let miner = Arc::new(MinerService::new(
            Some(config.miner_rest_url.as_str().into()),
            Arc::new(StorePeers(store.clone())),
        )?);
        let state = HttpState::new(store.clone(), miner.clone(), health.clone())
            .with_operator_account(config.operator_account.clone())
            .with_geoip_path(config.geoip_db_path.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.listen_port)).await?;
        Ok::<_, Box<dyn Error + Send + Sync>>((miner, router(state), listener))
    }
    .await;
    let (miner, router, listener) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            close_store(store).await?;
            return Err(error);
        }
    };
    let cancellation = tokio_util::sync::CancellationToken::new();
    let mut tasks = lifecycle::TaskSupervisor::new(cancellation.clone());
    let http_cancel = cancellation.clone();
    tasks.spawn("http", async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(http_cancel.cancelled_owned())
            .await
            .map_err(|error| error.to_string())
    });
    let chain_slot: SharedChain = Arc::default();
    let shutdown_budget = Duration::from_secs(config.limits.shutdown_deadline_sec);
    if config.run_indexer {
        let (bound, bound_receiver) = tokio::sync::watch::channel(false);
        let interval = Duration::from_secs(config.limits.miner_poll_interval_sec);
        tasks.spawn(
            "miner",
            poll_miner(
                store.clone(),
                miner,
                health.clone(),
                bound_receiver,
                interval,
                chain_slot.clone(),
                cancellation.clone(),
            ),
        );
        tasks.spawn(
            "indexer",
            run_indexer(
                Arc::new(config),
                store.clone(),
                health.clone(),
                bound,
                chain_slot.clone(),
                cancellation.clone(),
            ),
        );
        health.set_phase(Phase::Connecting);
    } else {
        drop(miner);
        health.set_phase(Phase::Ready);
    }
    health.heartbeat(RequiredTask::Watchdog);
    tasks.spawn("watchdog", watchdog(health.clone(), cancellation));
    let signal_health = health.clone();
    let signal = async move {
        let result = lifecycle::shutdown_signal().await;
        signal_health.set_phase(Phase::Stopping);
        result
    };
    tasks
        .run(
            signal,
            shutdown_budget,
            |name| {
                let task = match name {
                    "http" => RequiredTask::Http,
                    "indexer" => RequiredTask::Indexer,
                    "miner" => RequiredTask::Miner,
                    _ => RequiredTask::Watchdog,
                };
                health.task_exited(task);
            },
            async move {
                let chain = chain_slot.lock().await.take();
                let disconnected = if let Some(chain) = chain {
                    chain.disconnect().await.map_err(|error| error.to_string())
                } else {
                    Ok(())
                };
                let closed = close_store(store).await.map_err(|error| error.to_string());
                disconnected.and(closed)
            },
        )
        .await?;
    Ok(())
}
