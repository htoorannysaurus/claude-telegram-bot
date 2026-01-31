/**
 * Heartbeat module for Claude Telegram Bot.
 *
 * Sends periodic prompts to keep sessions alive and allow proactive agent behavior.
 * Inspired by clawdbot's heartbeat implementation.
 */

import { session } from "./session";
import {
  HEARTBEAT_ENABLED,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PROMPT,
} from "./config";

// Special token that Claude can include to suppress response delivery
export const HEARTBEAT_TOKEN = "[[HEARTBEAT_ACK]]";

// Max length for acknowledgment-only responses (suppressed)
const MAX_ACK_LENGTH = 30;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeat: Date | null = null;

/**
 * Check if a response should be suppressed (heartbeat acknowledgment only).
 */
export function shouldSuppressHeartbeatResponse(response: string): boolean {
  if (!response) return true;

  const trimmed = response.trim();

  // Empty response
  if (!trimmed) return true;

  // Contains heartbeat token - strip it and check what's left
  if (trimmed.includes(HEARTBEAT_TOKEN)) {
    const stripped = trimmed.replace(HEARTBEAT_TOKEN, "").trim();
    // If nothing left, or just a short ack, suppress
    if (!stripped || stripped.length <= MAX_ACK_LENGTH) {
      return true;
    }
  }

  // Short responses that look like acks
  const ackPatterns = [
    /^(ok|okay|ack|acknowledged|noted|✓|👍)\.?$/i,
    /^heartbeat (ok|received|acknowledged)\.?$/i,
    /^session (active|alive)\.?$/i,
  ];

  for (const pattern of ackPatterns) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Strip heartbeat token from response for delivery.
 */
export function stripHeartbeatToken(response: string): string {
  return response.replace(HEARTBEAT_TOKEN, "").trim();
}

/**
 * Run a single heartbeat.
 */
async function runHeartbeat(): Promise<void> {
  // Skip if session not active
  if (!session.isActive || !session.sessionId) {
    console.log("[Heartbeat] No active session, skipping");
    return;
  }

  // Skip if query is currently running
  if (session.isRunning) {
    console.log("[Heartbeat] Query in progress, skipping");
    return;
  }

  console.log(`[Heartbeat] Sending heartbeat to session ${session.sessionId.slice(0, 8)}...`);
  lastHeartbeat = new Date();

  try {
    // Silent status callback - don't send anything to Telegram
    const silentCallback = async () => {};

    const response = await session.sendMessageStreaming(
      HEARTBEAT_PROMPT,
      "heartbeat",
      0, // No user ID for heartbeat
      silentCallback,
      undefined, // No chat ID
      undefined  // No context
    );

    // Check if we should deliver this response
    if (shouldSuppressHeartbeatResponse(response)) {
      console.log("[Heartbeat] Response suppressed (ack only)");
    } else {
      // Real content - log it but don't deliver (no chat context)
      // In future: could deliver to configured target
      const preview = stripHeartbeatToken(response).slice(0, 100);
      console.log(`[Heartbeat] Response with content: ${preview}...`);
    }
  } catch (error) {
    console.error(`[Heartbeat] Error: ${error}`);
  }
}

/**
 * Start the heartbeat timer.
 */
export function startHeartbeat(): void {
  if (!HEARTBEAT_ENABLED) {
    console.log("[Heartbeat] Disabled via config");
    return;
  }

  if (heartbeatTimer) {
    console.log("[Heartbeat] Already running");
    return;
  }

  console.log(`[Heartbeat] Starting with interval ${HEARTBEAT_INTERVAL_MS}ms`);

  heartbeatTimer = setInterval(() => {
    runHeartbeat().catch((err) => {
      console.error("[Heartbeat] Unhandled error:", err);
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Don't prevent process exit
  heartbeatTimer.unref?.();
}

/**
 * Stop the heartbeat timer.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log("[Heartbeat] Stopped");
  }
}

/**
 * Get heartbeat status for /status command.
 */
export function getHeartbeatStatus(): string {
  if (!HEARTBEAT_ENABLED) {
    return "Heartbeat: disabled";
  }

  const running = heartbeatTimer !== null;
  const lastStr = lastHeartbeat
    ? `${Math.round((Date.now() - lastHeartbeat.getTime()) / 1000)}s ago`
    : "never";

  return `Heartbeat: ${running ? "running" : "stopped"}, last: ${lastStr}, interval: ${Math.round(HEARTBEAT_INTERVAL_MS / 60000)}m`;
}

/**
 * Trigger an immediate heartbeat (for testing or manual trigger).
 */
export async function triggerHeartbeat(): Promise<void> {
  await runHeartbeat();
}
