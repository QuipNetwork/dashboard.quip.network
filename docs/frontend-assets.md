# Frontend asset loading

The dashboard now loads chart and map code when you open those views. The
first page load is smaller. The figures below show the change.

## The problem

The dashboard uses Nivo for charts and react-simple-maps for maps. Before this
change, the browser loaded both on the first visit. It fetched them even when
the user stayed on the default view.

The default view does not draw a chart or a map. The Network and Compute views do. Loading that code up front wasted bytes for the common path.

## The change

Two views, Network and Compute, now defer loading. They use React `lazy()` and
`Suspense` in `src/pages/Dashboard.tsx`. Vite splits their code into separate
output chunks. The browser downloads those chunks only when the user opens the
Network or Compute view.

The heavy library code moves out of the entry chunk:

- Nivo lives in a shared `nivo-bar` chunk.
- `react-simple-maps` lives in the Network view chunk.
- Both chunks are reachable only through the two lazy view entry points.

The build emits a Vite module manifest at `dist/.vite/manifest.json`. The
bundle test in `src/lib/bundle-output.test.ts` reads that manifest to assert
the graph reachability. This avoids scanning minified JavaScript for library
names, which produces false positives from Vite chunk naming.

## Measured before and after

All numbers are zlib gzip level 6 over the production build output in
`apps/frontend/dist`. The baseline is the eager build on commit
`a587eed6dd1f3b62129083377cf39ebfbf421fe5`.

| Asset                                  | Before (gzip)      | After (gzip)       |
| -------------------------------------- | ------------------ | ------------------ |
| Initial JavaScript                     | 247 KB (247,112 B) | 75 KB (74,973 B)   |
| All JavaScript (initial plus deferred) | 247 KB             | 249 KB (248,598 B) |

The entry chunk falls from 247 KB to 75 KB gzip, a reduction of 172 KB, or
about 70 percent. The total bytes the page can eventually download rises
slightly to 249 KB because the deferred chunks add their own module wrapper
overhead.

## Initial versus eventually downloaded bytes

The distinction matters:

- **Initial bytes** are what the browser downloads before the user can
  interact. This change cuts these from 247 KB to 75 KB gzip.
- **Eventually downloaded bytes** are what the browser downloads if the user
  opens every view. This is the sum of all chunks, about 249 KB gzip.

For a user who stays on the default view, the saving is the full 172 KB. For a
user who visits all views, the change trades a one-time up-front cost for a
smaller first paint and per-view downloads. Opening a deferred view requires another download before that view can render.

## Verification

Run from the repository root so the test preload applies:

```sh
bun run build
bun test --preload ./apps/frontend/src/test/setup.ts apps/frontend
```

`bun run build` runs the frontend build and the no-polkadot-in-bundle guard.
The bundle test checks the manifest graph and deferred view chunks. It also checks that initial gzip size stays below the measured baseline. `@polkadot/*` stays out of every asset.

## Server address

The combined image uses the same origin for the frontend and API. Leave
`VITE_API_BASE_URL` unset for that build.

For a static Netlify deployment, set `VITE_API_BASE_URL` to the public Rust API
origin, such as `https://node.example.com`, before building. The frontend adds
the `/api/...` paths. This address is public and contains no credentials. The
Netlify build command fails when the address is missing. Configure the value
through [Netlify build environment variables](https://docs.netlify.com/build/configure-builds/environment-variables/).

The Netlify configuration serves static assets and the single-page app.
The Rust API replaces the former telemetry function. Local development can
use `VITE_API_PROXY` to select a running server.
