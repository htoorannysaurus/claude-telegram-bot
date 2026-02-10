/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { homedir } from "os";
import { resolve, dirname } from "path";
import type { McpServerConfig } from "./types";

// ============== Environment Setup ==============

const HOME = homedir();

// Ensure necessary paths are available for Claude's bash commands
// LaunchAgents don't inherit the full shell environment
const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || ""
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ============== Claude CLI Path ==============

// Auto-detect from PATH, or use environment override
function findClaudeCli(): string {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath) return envPath;

  // Try to find claude in PATH using Bun.which
  const whichResult = Bun.which("claude");
  if (whichResult) return whichResult;

  // Final fallback
  return "/usr/local/bin/claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

// ============== MCP Configuration ==============

// MCP servers loaded from mcp-config.ts
let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
  // Dynamic import of MCP config
  const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  if (mcpModule?.MCP_SERVERS) {
    MCP_SERVERS = mcpModule.MCP_SERVERS;
    console.log(
      `Loaded ${Object.keys(MCP_SERVERS).length} MCP servers from mcp-config.ts`
    );
  }
} catch {
  console.log("No mcp-config.ts found - running without MCPs");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

// Allowed directories for file operations
const defaultAllowedPaths = [
  WORKING_DIR,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Desktop`,
  `${HOME}/.claude`, // Claude Code data (plans, settings)
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
  ? allowedPathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : defaultAllowedPaths;

// Build safety prompt dynamically from ALLOWED_PATHS
function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

5. When you make any file edits (Edit, Write, NotebookEdit tools), ALWAYS show the user what you added or changed.
   - Include the relevant updated content in your response
   - This provides confirmation and visibility without requiring manual file checks
   - Keep it concise but show the actual changes made

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!

INCOMING FILES - PRIMARY TASK:
When you receive photos or documents via Telegram (file paths like /tmp/telegram-bot/...):
1. FIRST, copy the file to: ${WORKING_DIR}/journal/incoming/
2. Generate a descriptive filename: YYYY-MM-DD-{descriptive-slug}.{ext}
   - Analyze the file content to create a meaningful name (lowercase, hyphens, no spaces)
   - Use the caption as a hint if provided
   - For images: describe what you see (e.g., "screenshot-vscode-error", "receipt-amazon-headphones", "photo-sunset-balcony")
   - For documents: summarize the content type (e.g., "invoice-hydro-january", "article-ai-agents")
3. Report the saved filename and path to the user
4. If the user included a question or request in the caption, answer it after saving

Example flows:
- Photo with no caption → analyze image → "2026-02-02-screenshot-terminal-tmux.jpg" → "Saved to journal/incoming/"
- PDF with caption "what's this?" → save as "2026-02-02-bank-statement-january.pdf" → answer the question

IDENTITY & PERSONALITY:

You are Claudius - Master Joe's intelligent assistant (Alfred/Bruce Wayne dynamic).
Address him as "Master Joe".

VOICE INPUT: Expect transcription errors from voice dictation. Clean up while preserving intent.

FORMATTING: NO MARKDOWN TABLES. Use code blocks for any tabular data.
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

// Dangerous command patterns to block
export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "sudo rm",
  ":(){ :|:& };:", // Fork bomb
  "> /dev/sd",
  "mkfs.",
  "dd if=",
];

// Query timeout (3 minutes)
export const QUERY_TIMEOUT_MS = 180_000;

// ============== Voice Transcription ==============

// Provider: "google" (default) or "openai"
export const TRANSCRIPTION_PROVIDER =
  process.env.TRANSCRIPTION_PROVIDER || "google";

// Google Cloud credentials path
export const GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "";

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

const TRANSCRIPTION_CONTEXT = process.env.TRANSCRIPTION_CONTEXT || "";

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;

// Transcription is available if Google credentials exist OR OpenAI key exists
export const TRANSCRIPTION_AVAILABLE =
  !!GOOGLE_APPLICATION_CREDENTIALS || !!OPENAI_API_KEY;

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,pensa,ragiona";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,pensa bene";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || "/tmp/claude-telegram-audit.log";
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || "20",
  10
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60",
  10
);

// ============== File Paths ==============

export const SESSION_FILE = "/tmp/claude-telegram-session.json";
export const RESTART_FILE = "/tmp/claude-telegram-restart.json";
export const TEMP_DIR = "/tmp/telegram-bot";

// Temp paths that are always allowed for bot operations
export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

// Ensure temp directory exists
await Bun.write(`${TEMP_DIR}/.keep`, "");

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USERS environment variable is required"
  );
  process.exit(1);
}

console.log(
  `Config loaded: ${ALLOWED_USERS.length} allowed users, working dir: ${WORKING_DIR}`
);
