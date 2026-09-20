# Caching the Rust build on runner hosts

The Rust test job keeps Cargo state on a host volume, not in the GitLab tar
cache. Each amd64 runner host must provide that volume. Without it the job
still passes, but every build starts cold.

Affected job: `rust`. It extends the `.cargo-host-cache` template in
`.gitlab-ci.yml`.

## Why the tar cache is not used

The GitLab cache archives a directory into a zip file at the end of a job.
A Rust `target/` for this workspace holds tens of thousands of files. The
archive takes minutes to write and can exceed the job timeout. A killed
archiver writes nothing, so the next run also starts cold.

The archive goes to disk on the runner host that ran the job. The amd64 pool
has more than one host. A job that runs on a different host always misses
the archive.

The host volume avoids both failures. It lives on each host and persists
between pipelines that run on that host.

## Host setup

Do these steps on each amd64 runner host.

The path inside the container is always `/ci-cache`. The path on the host is
a per-host choice. Put it on a disk with room.

1. Create the directory:

   ```sh
   mkdir -p /srv/ci-cache
   ```

2. Mount it into the job containers. Edit `/etc/gitlab-runner/config.toml`:

   ```toml
   [[runners]]
     name = "lovelace"
     [runners.docker]
       volumes = ["/cache", "/srv/ci-cache:/ci-cache"]
   ```

   Keep the `/cache` entry. The `volumes` key replaces the whole list, and
   the runner needs `/cache` for the jobs that still use the GitLab cache.

`gitlab-runner` watches `config.toml` and reloads it. Do not restart the
service. A restart cancels the jobs that are running.

The toolchain image sets no `USER`, so jobs run as root. Root writes to the
directory whatever its ownership, so you need no ownership change.

## Directory layout

The template sets these variables:

```yaml
CARGO_HOME: /ci-cache/cargo-home
CARGO_TARGET_DIR: /ci-cache/$CI_CONCURRENT_ID/$CI_JOB_NAME/target
```

Jobs share `CARGO_HOME`. Cargo reads the registry almost entirely and locks
it correctly.

`CI_CONCURRENT_ID` is the runner execution slot. Two pipelines on one host
get separate target directories, so neither blocks on the Cargo target lock.
The runner reuses slot numbers across pipelines, which is what keeps a
directory warm.

Plan for one target directory per slot per job. With a runner concurrency of
2, plan for 2 directories.

## Workspace crates rebuild every run

The job starts with `cargo clean -p` for the three workspace crates. Cargo
decides whether a workspace crate is fresh by comparing file modification
times. Another pipeline can write a build of an older commit into the shared
target directory after this job checks out its source. That build looks newer
than the source, so Cargo uses it. A test that calls a new method then fails
to compile.

Cleaning the workspace crates makes them rebuild on every run. Third-party
dependencies take most of the build time, and they stay cached.

## Pruning

Each host must prune its own cache directory. A scheduled CI job cannot do
this, because a scheduled job runs on one runner only.

Add a cron entry or a systemd timer on each host. Use `cargo sweep`:

```sh
cargo sweep --time 14 --recursive /srv/ci-cache
```

`cargo sweep` reads Cargo metadata, removes only build artifacts, and judges
age by modification time. Install it with `cargo install cargo-sweep`.

Check the size when a build slows down without an obvious cause:

```sh
du -sh /srv/ci-cache/*
```
