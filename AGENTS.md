# Repository Agent Guide

This repository has a maintained knowledge wiki in `wiki/`. Read `wiki/index.md`
before answering repository-level questions or making architectural changes.

## Source Boundary

- Tracked application code, configuration, infrastructure, and `docs/` are the
  source of truth. Do not treat wiki pages as authoritative over them.
- `wiki/` is generated and maintained analysis. Update it when a change affects
  its documented behavior, architecture, deployment, security posture, or
  operational workflow.
- Cite source files with relative Markdown links. Record uncertainty and
  contradictions rather than inferring missing facts.

## Wiki Operations

- Ingest: read the relevant source files, update the affected wiki pages and
  `wiki/index.md`, then append an entry to `wiki/log.md`.
- Query: start at `wiki/index.md`, read the relevant pages, and cite both wiki
  pages and source files in the response.
- Lint: check for stale claims, contradictions, broken links, orphan pages, and
  unrepresented important components. Log material fixes.

## Conventions

- Keep pages concise and use relative Markdown links.
- `wiki/index.md` is the content catalog. `wiki/log.md` is append-only.
- Begin log entries with `## [YYYY-MM-DD] operation | Title`.
- Do not add unverified implementation details to the wiki.
