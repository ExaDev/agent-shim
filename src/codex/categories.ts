import type { CategoryClassification } from "../config/schema";

/** Codex's home layout, independent of Claude's classification and local overlay. Unknown entries stay private. */
export const CODEX_CATEGORIES: CategoryClassification = {
  secret: ["auth.json", "auth.json.*", "*.sqlite*", "*.db*", "identity.json", "cap_sid", "credentials*", "secrets*"],
  runtime: [".git*", ".DS_Store", "log", "logs", "tmp", "cache", "shell_snapshots", "models_cache.json", "version.json", "packages", "bin", "state", "otel"],
  history: ["sessions", "archived_sessions", "history.jsonl", "session_index.jsonl", "memories"],
  knowledge: ["AGENTS.md", "AGENTS.override.md", "skills", "rules", "agents", "prompts"],
  settings: ["config.toml", "*.config.toml"],
};
