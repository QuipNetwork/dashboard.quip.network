# Dashboard UI layout inventory

Every table / chart / figure, listed in current top-to-bottom render order under
its tab. Edit this file to reorder or move things: shuffle lines within a tab,
cut a line and paste it under a different tab, or annotate a line (e.g.
"→ move above X", "→ drop", "→ collapse by default"). Send it back and I'll
implement the changes.

Tab order in the header: **My Node · Network · Compute · Chain** (Chain hides
until the indexer has produced chain data; **Node** is a detail page reached by
"More info" links, not a tab).

## Header (always visible)

1. `SyncIndicator` — badge — indexer/chain freshness dot
2. `CurrentBlockIndicator` — badge — current block / in-flight qblock number
3. Connected Miner top right - self address + name
4. By Type / By Node aggregation toggle — shown on Network and Compute only

## My Node

1. Connected Node header — card — self address + name + registered/deposit badge
2. QBlocks Won / Rewards Earned / Last QBlock Won — stat tiles (row of 3)
3. `LastQBlockCard` — card — details of the last qblock this node won
4. `CurrentDifficultyCard` — card — live difficulty requirements
5. `CurrentAttemptsPanel` — table — live iteration trail for the in-flight qblock
6. `MinerStatsPanel` — stats + per-mode table — controller counters, one row per backend mode
7. `RecentMiningPanel` ("Recent Performance") — table, sortable — last 20 submissions, default QBlock# desc
8. Rank-Adjacent Miners (`NeighborsList`) — table — leaderboard window centered on this node

## Network

1. Node Locations (`NodeLocationMap`) — map — geo-located nodes
2. Compute totals — stat tiles (row of 4) — By Type: CPUs / GPUs / QPUs / PFLOPS; By Node: nodes / top / median / PFLOPS
3. On-chain miners (`ChainMinersTable`) — table, sortable — default last participation desc, search
4. CPU Model Breakdown — bar figure — _By Type mode only_
5. GPU Model Breakdown — bar figure — _By Type mode only_
6. Node Compute Contribution (`NodeLeaderboard`) — bar figure — _By Node mode only, replaces 4–5_

## Compute

1. Last Block FLOPS / Current Block FLOPS / Current Difficulty — stat tiles (row of 3)
2. Recent QBlocks (`RecentBlocksTable`) — table, sortable — default QBlock# desc, search + pagination
3. Mining Leaderboard (`Leaderboard`) — table, sortable — default rank asc, search
4. QBlocks Mined Over Time — line chart — cumulative per miner/type
5. Mining Time per QBlock — chart — range toggle 1H…ALL, All | By Type toggle (default By Type), x-axis = qblock id
6. Difficulty over time (`DifficultyChart`) — step line chart — range toggle 1H…ALL — full width
7. Total Compute Used — chart
8. Mining Nodes by Type — chart — _By Type mode only_
9. Energy Distribution — chart
10. Time to QBlock — chart
11. Probability of Meeting Difficulty — CDF chart — All Nodes | Best Nodes toggle (best = each type's top winner, in both aggregation modes)
12. Win Rate by Difficulty — chart — _By Type mode only_
13. Mining Cost by Difficulty — chart — CPU/GPU/QPU lines; All Nodes | Best Nodes and Time | Attempts toggles; in Time mode the QPU line is labeled QPUWC (wall clock — a device-time QPU line joins it once qpu_access_time data lands)
14. Cumulative QBlocks by Threshold — chart — All Nodes | Best Nodes toggle (best = each type's top winner, in both aggregation modes)

(4–5 and 7–14 render in 2-column grids; 6 spans full width between them. Grid
order is left-to-right, top-to-bottom.)

## Chain

1. Active Validators (`ValidatorsTable`) — table, sortable — default blocks authored desc
2. Mineable Topologies (`MineableTopologiesPanel`) — table, sortable — collapsible, open by default
3. BABE Authorities (`BabeAuthoritiesPanel`) — list — collapsible, closed by default

## Node (detail page, via "More info")

1. Node header — card — name, account, back button, deposit badge
2. QBlocks Won / Rewards Earned / Last QBlock Won — stat tiles (row of 3)
3. `LastQBlockCard` — card
4. `CurrentDifficultyCard` — card
5. `CurrentAttemptsPanel` — table — _only when the peer is live-reachable_
6. `MinerStatsPanel` — stats + per-mode table — _only when live-reachable_
7. `RecentMiningPanel` — table, sortable
8. Rank-Adjacent Miners (`NeighborsList`) — table
