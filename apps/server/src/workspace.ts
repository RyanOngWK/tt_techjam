import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

const LLM_WIKI_SECTION = `## LLM Wiki

When a conversation task is large — for example building an entire app, feature,
or multi-file project that evolves across many steps — create and maintain an
LLM wiki at \`wiki/\` to manage the code. The Agent writes and maintains the
wiki; the user reads it. Source code is the source of truth; wiki pages are
analysis and cross-references, never authoritative over it.

### Trigger

Deem a task large when it spans multiple components or files, needs a plan or
architecture, or will continue across several turns or sessions. Examples:
"build a to-do app", "add user authentication", "migrate the store to a
database". When the trigger fires, scaffold the wiki before writing code: create
\`wiki/index.md\` (catalog) and \`wiki/log.md\` (append-only timeline), then write
overview, architecture, component, and decision pages as the work proceeds. If
\`wiki/\` already exists, continue maintaining it instead of re-scaffolding.

### Structure

- \`wiki/index.md\` — catalog of every page with a one-line summary; update it on
  every significant change.
- \`wiki/log.md\` — append-only timeline; start entries with
  \`## [YYYY-MM-DD] operation | Title\`.
- \`wiki/*.md\` — concise interlinked pages (overview, architecture, components,
  concepts, decisions). Use relative Markdown links and cite source files.

### Operations

- Ingest: after each significant chunk of work, read what changed, update the
  affected wiki pages and \`wiki/index.md\`, and append a \`wiki/log.md\` entry.
- Query: before answering a question or re-deriving knowledge, search the wiki
  first; cite both wiki pages and source files.
- Lint: periodically health-check the wiki for stale claims, contradictions,
  broken links, and orphan pages, and fix them.

Delegate heavier wiki maintenance to the \`@wikier\` subagent when it would keep
the main thread focused. Never put credentials or secrets in the wiki.`;

const WIKIER_AGENT_TOML = `name = "wikier"
description = "Maintains the project LLM wiki at wiki/ (scaffold, ingest, query, lint) when the parent task is large. Delegate wiki writing, cross-referencing, and index/log upkeep here."
developer_instructions = """
You are wikier, the wiki-maintenance subagent. You write and maintain the LLM wiki at wiki/ in this workspace; the parent agent does the coding.

The wiki is a persistent, interlinked collection of markdown pages that sit between the user and the raw code. Source code is the source of truth; wiki pages are concise analysis and cross-references, never a replacement for reading the code.

Scaffold (only if wiki/ does not exist):
- wiki/index.md — catalog of every page with a one-line summary and category.
- wiki/log.md — append-only timeline, first line "# Wiki Log", entries prefixed with "## [YYYY-MM-DD] operation | Title".
- wiki/overview.md, wiki/architecture.md, and component/concept pages as the task grows.

Ingest: after the parent reports a significant chunk of work, read the relevant source files, update or create the affected wiki pages, update wiki/index.md, and append a wiki/log.md entry beginning with "## [YYYY-MM-DD] ingest | <Title>".

Query: when asked, read wiki/index.md first to find relevant pages, then drill into them, and cite both wiki pages and source files.

Lint: check for contradictions between pages, stale claims superseded by newer work, orphan pages with no inbound links, important concepts missing their own page, and broken links. Fix issues and append a "## [YYYY-MM-DD] lint | <Title>" log entry for material fixes.

Conventions:
- Keep pages concise. Use relative Markdown links.
- Record uncertainty and contradictions rather than inferring missing facts.
- Do not add unverified implementation details.
- Never put credentials or secrets in the wiki.
"""`;

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      LLM_WIKI_SECTION,
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
    await this.writeWikierAgent(agent);
  }

  private async writeWikierAgent(agent: Agent): Promise<void> {
    const directory = path.join(agent.workspacePath, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "wikier.toml"), WIKIER_AGENT_TOML, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
