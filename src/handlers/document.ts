/**
 * Document handler for Claude Telegram Bot.
 *
 * Downloads documents to journal/incoming/ with descriptive filenames.
 * PDFs and text files are saved; archives are processed for analysis.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS, WORKING_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { existsSync, mkdirSync, renameSync, copyFileSync } from "fs";

// Incoming directory for saved files
const INCOMING_DIR = `${WORKING_DIR}/journal/incoming`;

// Temp directory for processing
const TEMP_DIR = "/tmp/telegram-bot";

// Ensure directories exist
if (!existsSync(INCOMING_DIR)) {
  mkdirSync(INCOMING_DIR, { recursive: true });
}
if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

// Create document-specific media group buffer
const documentBuffer = createMediaGroupBuffer({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
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
 * Check if a filename is generic/meaningless.
 */
function isGenericFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  // Generic patterns: document.pdf, file.pdf, IMG_1234.pdf, scan001.pdf, etc.
  const genericPatterns = [
    /^document/i,
    /^file/i,
    /^img[_-]?\d/i,
    /^scan\d/i,
    /^image/i,
    /^\d+\./,
    /^untitled/i,
    /^new[_-]?document/i,
  ];
  return genericPatterns.some((p) => p.test(lower));
}

/**
 * Download a document to temp directory.
 */
async function downloadDocumentToTemp(ctx: Context): Promise<{ path: string; originalName: string }> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const originalName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const tempPath = `${TEMP_DIR}/${Date.now()}-${safeName}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(tempPath, buffer);

  return { path: tempPath, originalName };
}

/**
 * Extract text from a document for analysis.
 */
async function extractText(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF extraction using pdftotext CLI
  if (mimeType === "application/pdf" || extension === ".pdf") {
    try {
      const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
      return result.text();
    } catch (error) {
      console.error("PDF parsing failed:", error);
      return "[PDF parsing failed - ensure pdftotext is installed]";
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get the file extension including compound extensions like .tar.gz
 */
function getExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  const match = lower.match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

/**
 * Extract filename slug from Claude's response.
 */
function extractFilenameSlug(response: string): string | null {
  // Look for a hyphenated slug in the response
  const slugMatch = response.match(/["']?([\w-]{5,50})["']?/);
  if (slugMatch) {
    return slugMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }
  return null;
}

/**
 * Save document to incoming directory with appropriate filename.
 */
async function saveDocumentToIncoming(
  ctx: Context,
  tempPath: string,
  originalName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  const datePrefix = getDatePrefix();
  const extension = getExtension(originalName);

  try {
    let finalFilename: string;

    // If filename is already descriptive, use it with date prefix
    if (!isGenericFilename(originalName)) {
      // Clean up the original name
      const baseName = originalName
        .replace(extension, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      finalFilename = `${datePrefix}-${baseName}${extension}`;
    } else {
      // Generic filename - ask Claude to suggest based on content
      let contentPreview = "";
      try {
        const content = await extractText(tempPath);
        contentPreview = content.slice(0, 2000);
      } catch {
        contentPreview = "[Could not extract content]";
      }

      const prompt = `I'm saving a document. Based on this content preview, suggest a descriptive filename slug (3-5 words, lowercase, hyphens).

Original filename: ${originalName}
${caption ? `User context: "${caption}"` : ""}

Content preview:
${contentPreview}

Respond with ONLY the filename slug. Example: "invoice-hydro-january" or "tax-return-2025"`;

      // Set conversation title
      if (!session.isActive) {
        session.conversationTitle = "[Document Save]";
      }

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

        const slug = extractFilenameSlug(response);
        if (slug && slug.length >= 5) {
          finalFilename = `${datePrefix}-${slug}${extension}`;
        } else {
          // Fallback - use cleaned response
          const cleanSlug = response
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 40);
          finalFilename = cleanSlug.length >= 5
            ? `${datePrefix}-${cleanSlug}${extension}`
            : `${datePrefix}-document-${Date.now()}${extension}`;
        }
      } catch (error) {
        console.error("Claude filename suggestion failed:", error);
        finalFilename = `${datePrefix}-document-${Date.now()}${extension}`;
      }
    }

    // Move file to incoming
    const newPath = `${INCOMING_DIR}/${finalFilename}`;
    renameSync(tempPath, newPath);
    console.log(`Saved document: ${newPath}`);

    await ctx.reply(`📄 Saved: journal/incoming/${finalFilename}`);
    await auditLog(userId, username, "DOCUMENT_SAVE", originalName, `Saved as: ${finalFilename}`);
  } catch (error) {
    console.error("Failed to save document:", error);
    // Try to save with fallback name
    const fallbackName = `${datePrefix}-document-${Date.now()}${extension}`;
    try {
      renameSync(tempPath, `${INCOMING_DIR}/${fallbackName}`);
      await ctx.reply(`📄 Saved with fallback name: journal/incoming/${fallbackName}`);
    } catch {
      await ctx.reply(`❌ Failed to save document. File is at: ${tempPath}`);
    }
  } finally {
    stopProcessing();
    typing.stop();
  }
}

// ============== Archive Processing (unchanged) ==============

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(
  archivePath: string,
  fileName: string
): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  if (ext === ".zip") {
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false })
  );
  entries.sort();
  return entries.slice(0, 100);
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(
  extractDir: string
): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = `${extractDir}/${relativePath}`;
    const stat = await Bun.file(fullPath).exists();
    if (!stat) continue;

    const fileInfo = Bun.file(fullPath);
    const size = fileInfo.size;
    if (size === 0) continue;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;
    if (size > 100000) continue;

    try {
      const text = await fileInfo.text();
      const truncated = text.slice(0, 10000);
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * Process an archive file (analyze, don't save).
 */
async function processArchive(
  ctx: Context,
  archivePath: string,
  fileName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
    parse_mode: "HTML",
  });

  try {
    console.log(`Extracting archive: ${fileName}`);
    const extractDir = await extractArchive(archivePath, fileName);
    const { tree, contents } = await extractArchiveContent(extractDir);
    console.log(`Extracted: ${tree.length} files, ${contents.length} readable`);

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `📦 Extracted <b>${fileName}</b>: ${tree.length} files, ${contents.length} readable`,
      { parse_mode: "HTML" }
    );

    const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
    const contentsStr =
      contents.length > 0
        ? contents.map((c) => `--- ${c.name} ---\n${c.content}`).join("\n\n")
        : "(no readable text files)";

    const prompt = caption
      ? `Archive: ${fileName}\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}\n\n---\n\n${caption}`
      : `Please analyze this archive (${fileName}):\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}`;

    if (!session.isActive) {
      const rawTitle = caption || `[Archive: ${fileName}]`;
      const title = rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
      session.conversationTitle = title;
    }

    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "ARCHIVE", `[${fileName}] ${caption || ""}`, response);
    await Bun.$`rm -rf ${extractDir}`.quiet();

    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
  } catch (error) {
    console.error("Archive processing error:", error);
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    await ctx.reply(`❌ Failed to process archive: ${String(error).slice(0, 100)}`);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

// ============== Media Group Processing ==============

/**
 * Process multiple document paths (for media groups).
 */
async function processDocumentPaths(
  ctx: Context,
  paths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  const datePrefix = getDatePrefix();
  const slug = caption
    ? caption.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)
    : "documents";

  const savedFiles: string[] = [];

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const originalExt = getExtension(path);
    const newName = `${datePrefix}-${slug}-${i + 1}${originalExt}`;
    const newPath = `${INCOMING_DIR}/${newName}`;

    try {
      renameSync(path, newPath);
      savedFiles.push(newName);
      console.log(`Saved: ${newPath}`);
    } catch (error) {
      console.error(`Failed to save ${path}:`, error);
    }
  }

  if (savedFiles.length > 0) {
    await ctx.reply(
      `📄 Saved ${savedFiles.length} documents to journal/incoming/\n` +
      savedFiles.map((f) => `• ${f}`).join("\n")
    );
  } else {
    await ctx.reply("❌ Failed to save documents.");
  }
}

// ============== Main Handler ==============

/**
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText = TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isArchiveFile = isArchive(fileName);

  if (!isPdf && !isText && !isArchiveFile) {
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
      `Supported: PDF, archives (${ARCHIVE_EXTENSIONS.join(", ")}), ${TEXT_EXTENSIONS.join(", ")}`
    );
    return;
  }

  // 4. Download document
  let tempPath: string;
  let originalName: string;
  try {
    const result = await downloadDocumentToTemp(ctx);
    tempPath = result.path;
    originalName = result.originalName;
  } catch (error) {
    console.error("Failed to download document:", error);
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  // 5. Archive files - process for analysis (don't save)
  if (isArchiveFile) {
    console.log(`Received archive: ${fileName} from @${username}`);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
      return;
    }

    await processArchive(ctx, tempPath, fileName, ctx.message?.caption, userId, username, chatId);
    return;
  }

  // 6. Single document - save to incoming
  if (!mediaGroupId) {
    console.log(`Received document: ${fileName} from @${username}`);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
      return;
    }

    const statusMsg = await ctx.reply("📄 Saving document...");
    await saveDocumentToIncoming(ctx, tempPath, originalName, ctx.message?.caption, userId, username, chatId);

    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    return;
  }

  // 7. Media group - buffer with timeout
  await documentBuffer.addToGroup(
    mediaGroupId,
    tempPath,
    ctx,
    userId,
    username,
    processDocumentPaths
  );
}
