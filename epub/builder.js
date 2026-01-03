const Epub = require("epub-gen");
const fs = require("fs");
const path = require("path");

// Ensure output directory exists
if (!fs.existsSync("output")) {
  fs.mkdirSync("output", { recursive: true });
}

async function createEpub(title, author, chapters) {
  // Sanitize filename
  const sanitized = title
    .replace(/[<>:"/\\|?*]/g, "")
    .substring(0, 100)
    .trim() || "novel";

  const filePath = path.join("output", `${sanitized}.epub`);

  // Format chapters with proper HTML structure
  const content = chapters.map((ch, idx) => ({
    title: ch.title || `Chapter ${idx + 1}`,
    data: `<div class="chapter">${ch.content || "<p>No content available</p>"}</div>`
  }));

  try {
    const epub = new Epub({
      title: title || "Unknown Novel",
      author: author || "Unknown Author",
      content: content,
      output: filePath,
      fonts: []
    }, filePath);

    await epub.promise;

    return filePath;
  } catch (err) {
    console.error("EPUB creation error:", err);
    throw new Error(`Failed to create EPUB: ${err.message}`);
  }
}

module.exports = { createEpub };
