/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Downloads photos to journal/incoming/ and uses Claude to generate descriptive filenames.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS, WORKING_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";

// Incoming directory for saved files
const INCOMING_DIR = `${WORKING_DIR}/journal/incoming`;

// Ensure incoming directory exists
if (!existsSync(INCOMING_DIR)) {
  mkdirSync(INCOMING_DIR, { recursive: true });
}

// Create photo-specific media group buffer
const photoBuffer = createMediaGroupBuffer({
  emoji: "📷",
  itemLabel: "photo",
  itemLabelPlural: "photos",
});

/**
 * Get today's date in YYYY-MM-DD format.
 */
function getDatePrefix(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Download a photo directly to the incoming directory with a temp name.
 */
async function downloadPhotoToIncoming(ctx: Context): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  // Get the largest photo
  const file = await ctx.getFile();

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const tempPath = `${INCOMING_DIR}/incoming-${timestamp}-${random}.jpg`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(tempPath, buffer);

  return tempPath;
}

/**
 * Extract filename from Claude's response.
 * Looks for patterns like "2026-02-02-descriptive-name.jpg" or just "descriptive-name"
 */
function extractFilename(response: string, datePrefix: string): string | null {
  // Try to find a filename pattern in the response
  // Pattern 1: Full filename with date (2026-02-02-something.jpg)
  const fullMatch = response.match(/(\d{4}-\d{2}-\d{2}-[\w-]+\.jpg)/i);
  if (fullMatch) {
    return fullMatch[1].toLowerCase();
  }

  // Pattern 2: Just the slug part (e.g., "screenshot-terminal-tmux")
  const slugMatch = response.match(/["']?([\w-]{5,50})["']?\.jpg/i);
  if (slugMatch) {
    return `${datePrefix}-${slugMatch[1].toLowerCase()}.jpg`;
  }

  // Pattern 3: Look for suggested name after common phrases
  const suggestedMatch = response.match(
    /(?:suggest|name|filename|called?|saved? as)[:\s]+["']?([\w-]{5,50})["']?/i
  );
  if (suggestedMatch) {
    const slug = suggestedMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, "-");
    return `${datePrefix}-${slug}.jpg`;
  }

  // Pattern 4: Look for a hyphenated phrase that looks like a filename
  const hyphenatedMatch = response.match(/\b([a-z]+-[a-z]+(?:-[a-z]+)*)\b/i);
  if (hyphenatedMatch && hyphenatedMatch[1].length >= 10) {
    return `${datePrefix}-${hyphenatedMatch[1].toLowerCase()}.jpg`;
  }

  return null;
}

/**
 * Process photos: get filename from Claude and rename.
 */
async function processPhotos(
  ctx: Context,
  photoPaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Mark processing started
  const stopProcessing = session.startProcessing();

  const datePrefix = getDatePrefix();

  // Build prompt asking Claude to suggest a filename
  let prompt: string;
  if (photoPaths.length === 1) {
    prompt = `Look at this image: ${photoPaths[0]}

Generate a descriptive filename for saving this image. The filename should:
- Be lowercase with hyphens (no spaces)
- Describe what's in the image (e.g., "screenshot-terminal-tmux", "receipt-amazon-headphones", "photo-sunset-balcony")
- Be concise but descriptive (3-6 words)

${caption ? `Context from user: "${caption}"` : ""}

Respond with ONLY the filename slug (I'll add the date prefix and extension). Example response: "screenshot-vscode-error"`;
  } else {
    // For multiple photos, just use a generic name with count
    const slug = caption
      ? caption.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)
      : "photo-batch";

    // Rename all files with numbered suffixes
    for (let i = 0; i < photoPaths.length; i++) {
      const newPath = `${INCOMING_DIR}/${datePrefix}-${slug}-${i + 1}.jpg`;
      try {
        renameSync(photoPaths[i], newPath);
        console.log(`Renamed: ${photoPaths[i]} -> ${newPath}`);
      } catch (error) {
        console.error(`Failed to rename ${photoPaths[i]}:`, error);
      }
    }

    await ctx.reply(
      `📷 Saved ${photoPaths.length} photos to journal/incoming/\n` +
      `Files: ${datePrefix}-${slug}-1.jpg through ${datePrefix}-${slug}-${photoPaths.length}.jpg`
    );
    stopProcessing();
    return;
  }

  // Set conversation title (if new session)
  if (!session.isActive) {
    session.conversationTitle = "[Photo Save]";
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    // Extract filename from response
    let finalFilename = extractFilename(response, datePrefix);

    // Fallback: use response directly if it looks like a slug
    if (!finalFilename && response.trim().length > 0) {
      const cleanSlug = response
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);

      if (cleanSlug.length >= 5) {
        finalFilename = `${datePrefix}-${cleanSlug}.jpg`;
      }
    }

    // Ultimate fallback
    if (!finalFilename) {
      const timestamp = Date.now();
      finalFilename = `${datePrefix}-photo-${timestamp}.jpg`;
    }

    // Rename the file
    const newPath = `${INCOMING_DIR}/${finalFilename}`;
    const oldPath = photoPaths[0];

    try {
      renameSync(oldPath, newPath);
      console.log(`Renamed: ${oldPath} -> ${newPath}`);

      // Send confirmation (this replaces the streaming response)
      await ctx.reply(`📷 Saved: journal/incoming/${finalFilename}`);
    } catch (renameError) {
      console.error("Failed to rename file:", renameError);
      await ctx.reply(`❌ Failed to save file. Image is at: ${oldPath}`);
    }

    await auditLog(userId, username, "PHOTO_SAVE", prompt, `Saved as: ${finalFilename}`);
  } catch (error) {
    await handleProcessingError(ctx, error, state.toolMessages);

    // On error, still try to save with a fallback name
    const fallbackName = `${datePrefix}-photo-${Date.now()}.jpg`;
    const newPath = `${INCOMING_DIR}/${fallbackName}`;
    try {
      renameSync(photoPaths[0], newPath);
      await ctx.reply(`📷 Saved with fallback name: journal/incoming/${fallbackName}`);
    } catch {
      // Leave in place
    }
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. For single photos, show status and rate limit early
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  if (!mediaGroupId) {
    console.log(`Received photo from @${username}`);
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    // Show status immediately
    statusMsg = await ctx.reply("📷 Saving image...");
  }

  // 3. Download photo directly to incoming directory
  let photoPath: string;
  try {
    photoPath = await downloadPhotoToIncoming(ctx);
  } catch (error) {
    console.error("Failed to download photo:", error);
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          "❌ Failed to download photo."
        );
      } catch (editError) {
        console.debug("Failed to edit status message:", editError);
        await ctx.reply("❌ Failed to download photo.");
      }
    } else {
      await ctx.reply("❌ Failed to download photo.");
    }
    return;
  }

  // 4. Single photo - process immediately
  if (!mediaGroupId && statusMsg) {
    await processPhotos(
      ctx,
      [photoPath],
      ctx.message?.caption,
      userId,
      username,
      chatId
    );

    // Clean up status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch (error) {
      console.debug("Failed to delete status message:", error);
    }
    return;
  }

  // 5. Media group - buffer with timeout
  if (!mediaGroupId) return; // TypeScript guard

  await photoBuffer.addToGroup(
    mediaGroupId,
    photoPath,
    ctx,
    userId,
    username,
    processPhotos
  );
}
