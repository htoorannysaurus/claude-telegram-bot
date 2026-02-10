/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import OpenAI from "openai";
import { SpeechClient } from "@google-cloud/speech";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  OPENAI_API_KEY,
  TRANSCRIPTION_PROMPT,
  TRANSCRIPTION_AVAILABLE,
  TRANSCRIPTION_PROVIDER,
  GOOGLE_APPLICATION_CREDENTIALS,
  TEMP_DIR,
} from "./config";

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ============== Google Speech Client ==============

let googleSpeechClient: SpeechClient | null = null;
if (GOOGLE_APPLICATION_CREDENTIALS) {
  googleSpeechClient = new SpeechClient({
    keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
  });
  console.log("Google Speech-to-Text client initialized");
}

// ============== Google TTS Client ==============

let googleTtsClient: TextToSpeechClient | null = null;
if (GOOGLE_APPLICATION_CREDENTIALS) {
  googleTtsClient = new TextToSpeechClient({
    keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
  });
  console.log("Google Text-to-Speech client initialized");
}

// ============== TTS Toggle State ==============

let ttsEnabled = false;

export function isTtsEnabled(): boolean {
  return ttsEnabled;
}

export function setTtsEnabled(enabled: boolean): void {
  ttsEnabled = enabled;
}

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      // Plain text format for readability
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    // Append to audit log file
    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, content);
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}

export async function auditLogAuth(
  userId: number,
  username: string,
  authorized: boolean
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "auth",
    user_id: userId,
    username,
    authorized,
  });
}

export async function auditLogTool(
  userId: number,
  username: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blocked = false,
  reason = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "tool_use",
    user_id: userId,
    username,
    tool_name: toolName,
    tool_input: toolInput,
    blocked,
  };
  if (blocked && reason) {
    event.reason = reason;
  }
  await writeAuditLog(event);
}

export async function auditLogError(
  userId: number,
  username: string,
  error: string,
  context = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "error",
    user_id: userId,
    username,
    error,
  };
  if (context) {
    event.context = context;
  }
  await writeAuditLog(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Voice Transcription ==============

/**
 * Transcribe audio using Google Cloud Speech-to-Text.
 * Uses OGG_OPUS encoding at 48kHz which works with Telegram voice messages.
 */
async function transcribeWithGoogle(filePath: string): Promise<string | null> {
  if (!googleSpeechClient) {
    console.warn("Google Speech client not available for transcription");
    return null;
  }

  try {
    const audioContent = await Bun.file(filePath).arrayBuffer();
    const audioBytes = Buffer.from(audioContent).toString("base64");

    const [response] = await googleSpeechClient.recognize({
      audio: { content: audioBytes },
      config: {
        encoding: "OGG_OPUS",
        sampleRateHertz: 48000,
        languageCode: "en-US",
        enableAutomaticPunctuation: true,
      },
    });

    const transcription = response.results
      ?.map((result) => result.alternatives?.[0]?.transcript)
      .filter(Boolean)
      .join(" ");

    return transcription || null;
  } catch (error) {
    console.error("Google transcription failed:", error);
    return null;
  }
}

/**
 * Transcribe audio using OpenAI Whisper.
 */
async function transcribeWithOpenAI(filePath: string): Promise<string | null> {
  if (!openaiClient) {
    console.warn("OpenAI client not available for transcription");
    return null;
  }

  try {
    const file = Bun.file(filePath);
    const transcript = await openaiClient.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });
    return transcript.text;
  } catch (error) {
    console.error("OpenAI transcription failed:", error);
    return null;
  }
}

/**
 * Transcribe voice message using configured provider.
 * Default: Google Cloud Speech-to-Text
 * Fallback: OpenAI Whisper (if Google fails or not configured)
 */
export async function transcribeVoice(
  filePath: string
): Promise<string | null> {
  // Try primary provider first
  if (TRANSCRIPTION_PROVIDER === "google" && googleSpeechClient) {
    console.log("Using Google Speech-to-Text");
    const result = await transcribeWithGoogle(filePath);
    if (result) {
      console.log("Google transcription successful");
      return result;
    }

    // Fall back to OpenAI if Google fails
    if (openaiClient) {
      console.log("Google transcription failed, falling back to OpenAI Whisper");
      const fallbackResult = await transcribeWithOpenAI(filePath);
      if (fallbackResult) console.log("OpenAI fallback successful");
      return fallbackResult;
    }
    return null;
  }

  // OpenAI as primary
  if (TRANSCRIPTION_PROVIDER === "openai" && openaiClient) {
    console.log("Using OpenAI Whisper");
    const result = await transcribeWithOpenAI(filePath);
    if (result) {
      console.log("OpenAI transcription successful");
      return result;
    }

    // Fall back to Google if OpenAI fails
    if (googleSpeechClient) {
      console.log("OpenAI transcription failed, falling back to Google");
      return transcribeWithGoogle(filePath);
    }
    return null;
  }

  // Try whatever is available
  if (googleSpeechClient) {
    return transcribeWithGoogle(filePath);
  }
  if (openaiClient) {
    return transcribeWithOpenAI(filePath);
  }

  console.warn("No transcription client available");
  return null;
}

// ============== Text-to-Speech ==============

/**
 * Convert text to speech using Google Cloud TTS and send as Telegram voice note.
 * Strips markdown/HTML formatting before synthesis.
 * Max 5000 chars per request (Google limit).
 */
export async function sendTtsVoiceNote(
  ctx: Context,
  text: string
): Promise<void> {
  if (!googleTtsClient) {
    console.warn("Google TTS client not available");
    return;
  }

  try {
    // Strip markdown/HTML formatting for cleaner speech
    let cleanText = text
      .replace(/<[^>]+>/g, "") // HTML tags
      .replace(/```[\s\S]*?```/g, "(code block omitted)") // code blocks
      .replace(/`[^`]+`/g, (match) => match.slice(1, -1)) // inline code
      .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
      .replace(/\*([^*]+)\*/g, "$1") // italic
      .replace(/__([^_]+)__/g, "$1") // bold alt
      .replace(/_([^_]+)_/g, "$1") // italic alt
      .replace(/#{1,6}\s*/g, "") // headers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
      .replace(/^\s*[-*+]\s+/gm, "") // list bullets
      .replace(/^\s*\d+\.\s+/gm, "") // numbered lists
      .trim();

    // Google TTS limit is 5000 bytes; truncate if needed
    if (cleanText.length > 4500) {
      cleanText = cleanText.slice(0, 4500) + "...";
    }

    if (!cleanText) return;

    const [response] = await googleTtsClient.synthesizeSpeech({
      input: { text: cleanText },
      voice: {
        languageCode: "en-US",
        name: "en-US-Journey-D", // Natural male voice
        ssmlGender: "MALE",
      },
      audioConfig: {
        audioEncoding: "OGG_OPUS",
        sampleRateHertz: 48000,
        speakingRate: 1.0,
      },
    });

    if (response.audioContent) {
      const audioBuffer = Buffer.from(response.audioContent as Uint8Array);
      const audioPath = `${TEMP_DIR}/tts_${Date.now()}.ogg`;
      await Bun.write(audioPath, audioBuffer);

      // Send as voice note (round bubble in Telegram)
      await ctx.replyWithVoice(new InputFile(audioPath));

      // Clean up
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(audioPath);
      } catch {
        // ignore cleanup errors
      }
    }
  } catch (error) {
    console.error("TTS failed:", error);
  }
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

// Import session lazily to avoid circular dependency
let sessionModule: {
  session: {
    isRunning: boolean;
    stop: () => Promise<"stopped" | "pending" | false>;
    markInterrupt: () => void;
    clearStopRequested: () => void;
  };
} | null = null;

export async function checkInterrupt(text: string): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  // Lazy import to avoid circular dependency
  if (!sessionModule) {
    sessionModule = await import("./session");
  }

  const strippedText = text.slice(1).trimStart();

  if (sessionModule.session.isRunning) {
    console.log("! prefix - interrupting current query");
    sessionModule.session.markInterrupt();
    await sessionModule.session.stop();
    await Bun.sleep(100);
    // Clear stopRequested so the new message can proceed
    sessionModule.session.clearStopRequested();
  }

  return strippedText;
}
