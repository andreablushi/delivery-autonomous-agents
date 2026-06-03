# Delivery Autonomous Agents

A project focused on the development and analysis of autonomous software agents, exploring their design, implementation, and applications in the Deliveroo.js domain, for the University of Trento.

<table align="center">
  <tr>
    <td align="center">
      <strong>
        <a href="docs/report/report.pdf">View Full Report (PDF)</a>
      </strong><br><br>
      <a href="docs/report/report.pdf">
        <img src="docs/media/report-preview.png" width="200" alt="Report preview">
      </a>
    </td>
    <td align="center">
      <strong>
        <a href="docs/presentation/presentation.pdf">View Full Presentation (PDF)</a>
      </strong><br><br>
      <a href="docs/presentation/presentation.pdf">
        <img src="docs/media/presentation-preview.png" width="350" alt="Presentation preview">
      </a>
    </td>
  </tr>
</table>

**Course:** Autonomous Software Agents  
**Professors:** Prof. Paolo Giorgini, Prof. Marco Robol  
**Authors:** Davide Donà (davide.dona-1@studenti.unitn.it), Andrea Blushi (andrea.blushi@studenti.unitn.it)

---

# Overview

## Prerequisites

- Node.js (version 14 or higher)
- npm (Node Package Manager)

## Setup Environment

Copy the `.env.example` file to `.env` and fill in the required values:

```bash
cp .env.example .env
```

By default the agent connects to a local Deliveroo.js server at `http://localhost:8080`.
To start the server, follow the instructions in the [Deliveroo.js repository](https://github.com/unitn-ASA/Deliveroo.js).

Then, install the project dependencies:

```bash
npm install
```

## PDDL Solver Setup

The BDI agent uses a PDDL solver for crate-clearing plans. Two modes are available, selected at startup by the `PAAS_HOST` environment variable:

- **`PAAS_HOST` unset** → local solver (default). Requires planutils installed locally.
- **`PAAS_HOST` set** → online solver via `@unitn-asa/pddl-client`. No local install needed.

### Option A — Local Solver

Requires Singularity CE and planutils installed in a Python virtual environment.

**1. Install Singularity CE** (system-level, required by planutils to run planner containers):

```bash
# Linux (Debian/Ubuntu)
sudo apt install singularity-ce

# macOS
brew install --cask singularity
```

**2. Set up planutils in a virtual environment:**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install planutils
planutils setup
planutils activate
planutils install dual-bfws-ffparser
```

`planutils setup` writes wrapper scripts to `~/.planutils/bin/` and the Singularity image is stored in `~/.planutils/` — both outside the venv, so they persist without it being active.

**3. Run the agent** — run `planutils activate` before starting. The solver resolves `~/.planutils/bin/dual-bfws-ffparser` directly.

### Option B — Online Solver

Set `PAAS_HOST` in your `.env` to the solver endpoint. No planutils or Singularity CE install needed:

```env
PAAS_HOST=https://solver.planning.domains:5001
```

The agent will use the unitn online solver (`@unitn-asa/pddl-client`) on startup. You can also point `PAAS_HOST` at a self-hosted instance of the planning service.

## Running the Agent

Four startup modes are available. Each has a production (`start:*`) and a debug (`dev:*`) variant — debug variants respect the `_DEBUG` value in `.env`.

| Command | Mode | Agents spawned | Tokens used |
|---|---|---|---|
| `npm start` / `npm run dev` | `bdi` | 1 BDI agent | `BDI_TOKEN` |
| `npm run start:llm` / `npm run dev:llm` | `llm` | 1 LLM agent | `LLM_TOKEN` |
| `npm run start:cooperative` / `npm run dev:cooperative` | `cooperative` | LLM + BDI as teammates | `LLM_TOKEN` + `BDI_TOKEN` |
| `npm run start:competitive` / `npm run dev:competitive` | `competitive` | N BDI agents | `COMPETITIVE_TOKEN_1..N` |
| `npm run build` | — | — | Type-check only (`tsc → dist/`) |

Set the matching tokens in `.env` before starting. Production scripts suppress all debug output; dev scripts enable it.

### LLM agent

Set `MISSION_AGENT_NAME` in `.env` to the in-game name of the human operator. The LLM agent filters incoming chat messages and only processes those from that sender.

Required `.env` keys for LLM / cooperative modes:

```env
LLM_BASE_URL=...   # OpenAI-compatible endpoint
LLM_API_KEY=...
MODEL_NAME=...
```

## Debug Logging

Set `_DEBUG` in `.env` to enable namespaced, color-coded log output. Each namespace is assigned a distinct color.

```bash
_DEBUG=*                  # all namespaces
_DEBUG=plan,execute       # only planning and execution
_DEBUG=llm-prompt         # user message + belief context sent to the LLM each turn
```

Available namespaces:

| Namespace | What it covers |
|---|---|
| `perceive` | Belief updates from socket events |
| `deliberate` | Desire generation and intention selection |
| `desire` | Desire scoring detail |
| `intention` | Intention validation and replanning triggers |
| `plan` | A* planning |
| `pddl` | PDDL crate-clearing planner |
| `execute` | Socket action loop (move / pickup / putdown) |
| `map` | Map belief updates |
| `api` | Server connection |
| `llm` | Incoming chat messages handled by the LLM agent |
| `llm-client` | Tool calls and tool results per hop |
| `llm-prompt` | User message + belief context sent to the model |
| `comm` | Outgoing chat messages (messenger) |

Production scripts (`npm start`, `npm run start:*`) always suppress debug output regardless of `.env`.  
Dev scripts (`npm run dev`, `npm run dev:*`) respect the `_DEBUG` value in `.env`.


## Repository Structure

```
src/
├── index.ts                        # Entry point; fans out into single or multi-agent mode
├── config.ts                       # All tunable numeric constants (timeouts, thresholds, …)
├── agents/
│   ├── bdi/                        # BDI agent
│   │   ├── bdi_agent.ts            # Main BDI agent class (perceive → deliberate → execute loop)
│   │   ├── belief/                 # Belief management (map, parcels, agents, rules)
│   │   ├── communication/          # Peer-injection dispatch and Messenger
│   │   ├── desire/                 # Desire generation and scoring
│   │   ├── intention/              # Intention queue management
│   │   ├── plan/                   # Planning (A*, PDDL fallback, collision avoidance)
│   │   └── execution/              # Socket action loop (move / pickup / putdown)
│   └── llm/                        # LLM agent (wraps BDI)
│       ├── llm_agent.ts            # Main LLM agent class
│       ├── client/                 # LLM API client and tool-call loop
│       ├── communication/          # Peer-injection broadcast helpers
│       ├── coordination/           # Periodic team coordinator
│       ├── prompt/                 # Prompt builders (main + coordination)
│       └── tools/                  # Tool definitions and handlers
├── models/                         # Shared data types and injection logic
└── utils/                          # Logger, metrics, API helpers
docs/
├── report/                         # Written report (LaTeX source + compiled PDF)
└── presentation/                   # Slide deck (LaTeX/Beamer source + compiled PDF)
```
