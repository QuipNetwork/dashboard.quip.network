# Quip Dashboard

Post-quantum mining telemetry dashboard for the Quip network. Visualises block production, mining times, compute usage, and active nodes across CPU, GPU, and QPU miners.

**Stack:** React, Vite, Tailwind CSS v4, Nivo charts, Zustand, Netlify Functions.

## Development

Everything runs in a Podman container via the `./run` helper.

```sh
# Install dependencies
./run bun install

# Start dev server (Netlify Dev + Vite on port 8888)
./run dev

# Component stories (Ladle on port 8888)
./run ladle

# Production build
./run build

# Shell into the container
./run sh
```

## Project structure

```
src/
  components/    UI components and charts
  hooks/         Data hooks (blocks over time, mining time, compute, nodes)
  store/         Zustand telemetry store
  styles/        Tailwind theme and base styles
  types/         TypeScript types
netlify/
  functions/     Serverless functions (telemetry API)
telemetry/       Raw block data (read by the netlify function)
.ladle/          Ladle (component stories) config
```
