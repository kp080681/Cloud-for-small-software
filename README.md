# Cloud for Small Software

> Build anywhere. Run here.

Small Software Cloud is an infrastructure platform for deploying and operating small bespoke software reliably, securely, and with minimal operational complexity.

## Core principle

> Build what we need. Prove it on ourselves. Open it to others. Let customers finance the cloud that follows.

## Project status

The project is currently in the thesis and architecture-definition stage.

## Source of truth

This repository is the permanent source of truth for product decisions, architecture, security, reliability, execution planning, validation, and economics.

Important work should not exist only inside a chat, local machine, or uncommitted working directory.

## Workstreams

- `docs/00-master-execution-graph/` - master dependency graph, gates, and build sequence
- `docs/01-whitepaper/` - product thesis, positioning, market, principles, and long-term vision
- `docs/02-v1-architecture/` - V1 system architecture and technical specifications
- `docs/03-security/` - workload isolation, secrets, abuse prevention, access, and deletion
- `docs/04-reliability/` - availability, latency, failure recovery, idempotency, and observability
- `docs/05-internal-proof/` - DealUp, DealOS, and Vantage validation
- `docs/06-external-alpha/` - first external workloads and learning
- `docs/07-distribution/` - GitHub, agencies, developer ecosystem, CLI, API, MCP, and agents
- `docs/08-economics/` - pricing, infrastructure cost, gross margin, usage, and revenue
- `decisions/` - architecture and product decision records

## Engineering principles

1. Reliability before breadth.
2. Security is architecture, not a later feature.
3. Supported means supported.
4. Reject unsupported workloads clearly.
5. Own the control plane before owning the compute plane.
6. Revenue earns complexity.
7. Keep customer applications portable.
8. Avoid unnecessary platform-added runtime latency.
9. Every critical operation must be observable and recoverable.
10. No hidden platform-specific hacks for proof applications.
# Utplava
