const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
require('dotenv').config();
require("dns").setDefaultResultOrder("ipv4first");

// ---- DATABASE ----
const { initializeDatabase, saveEpub, getUserLibrary, getEpubById, deleteEpub, updateEpub, getLibrarySize } = require("./db/library");

// ---- SCRAPERS ----
const { scrapeNovel: scrapeFreewebnovel } = require("./scrapers/freewebnovel");
const { scrapeNovel: scrapeRoyalroad } = require("./scrapers/royalroad");
const { scrapeNovel: scrapeWebnovel } = require("./scrapers/webnovel");
const { scrapeNovel: scrapeWattpad } = require("./scrapers/wattpad");
const { scrapeNovel: scrapeNovelUpdates } = require("./scrapers/novelupdates");
const { scrapeNovel: scrapeScribble } = require("./scrapers/scribble");
const { scrapeNovel: scrapeFanfiction } = require("./scrapers/fanfiction");
const { scrapeNovel: scrapeWuxiaworld } = require("./scrapers/wuxiaworld");
const { scrapeNovel: scrapeAO3 } = require("./scrapers/archiveofourown");
const { scrapeNovel: scrapeBoxnovel } = require("./scrapers/boxnovel");
const { scrapeNovel: scrapeReadlightnovel } = require("./scrapers/readlightnovel");
const { scrapeNovel: scrapeNovelfull } = require("./scrapers/novelfull");
const { scrapeNovel: scrapeMtlnovel } = require("./scrapers/mtlnovel");
const { scrapeNovel: scrapeGeneric } = require("./scrapers/generic");

const { createEpub } = require("./epub/builder");

// ---- SAFE ENV READ ----
const BOT_TOKEN = process.env.BOT_TOKEN;

console.log("BOT_TOKEN present:", !!BOT_TOKEN);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is NOT set. Waiting for Railway env injection...");
  setInterval(() => {
    console.error("⏳ BOT_TOKEN still missing...");
  }, 30000);
  process.exit(1);
}

// ---- INIT BOT ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Initialize database on startup
initializeDatabase().then(() => {
  console.log("📚 Library system initialized");
}).catch(err => {
  console.error("Failed to initialize database:", err);
});

// ---- SESSION STORAGE FOR URLS & STATES ----
const sessionURLs = new Map();
const waitingForRange = new Map();
let sessionCounter = 0;

function generateSessionId() {
  return `s_${++sessionCounter}`;
}

function storeNovelURL(url) {
  const sessionId = generateSessionId();
  sessionURLs.set(sessionId, url);
  setTimeout(() => sessionURLs.delete(sessionId), 3600000); // Auto-delete after 1 hour
  return sessionId;
}

function getNovelURL(sessionId) {
  return sessionURLs.get(sessionId);
}

function setWaitingForRange(chatId, sessionId, msgId) {
  waitingForRange.set(chatId, { sessionId, msgId });
  setTimeout(() => waitingForRange.delete(chatId), 600000); // Auto-delete after 10 min
}

function getWaitingForRange(chatId) {
  return waitingForRange.get(chatId);
}

function clearWaitingForRange(chatId) {
  waitingForRange.delete(chatId);
}

// ---- SITE DETECTION ----
function detectSite(url) {
  const domain = new URL(url).hostname.toLowerCase();

    if (domain.includes("freewebnovel")) return { name: "FreeWebNovel", scraper: scrapeFreewebnovel };
    if (domain.includes("readlightnovel")) return { name: "ReadLightNovel", scraper: scrapeReadlightnovel };
    if (domain.includes("archiveofourown")) return { name: "Archive of Our Own", scraper: scrapeAO3 };
    if (domain.includes("fanfiction.net")) return { name: "FanFiction.net", scraper: scrapeFanfiction };
    if (domain.includes("scribblehub")) return { name: "ScribbleHub", scraper: scrapeScribble };
    if (domain.includes("novelupdates")) return { name: "Novel Updates", scraper: scrapeNovelUpdates };
    if (domain.includes("wuxiaworld")) return { name: "Wuxiaworld", scraper: scrapeWuxiaworld };
    if (domain.includes("boxnovel")) return { name: "BoxNovel", scraper: scrapeBoxnovel };
    if (domain.includes("novelfull")) return { name: "NovelFull", scraper: scrapeNovelfull };
    if (domain.includes("mtlnovel")) return { name: "MTLNovel", scraper: scrapeMtlnovel };
    if (domain.includes("royalroad")) return { name: "Royal Road", scraper: scrapeRoyalroad };
    if (domain.includes("wattpad")) return { name: "Wattpad", scraper: scrapeWattpad };
    if (domain.includes("webnovel")) return { name: "WebNovel", scraper: scrapeWebnovel };
    if (domain.includes("lightnovelpub")) return { name: "LightNovelPub", scraper: scrapeGeneric };
    if (domain.includes("novelhall")) return { name: "NovelHall", scraper: scrapeGeneric };
    if (domain.includes("readnovelfull")) return { name: "ReadNovelFull", scraper: scrapeGeneric };
    if (domain.includes("allnovelnext")) return { name: "AllNovelNext", scraper: scrapeGeneric };
    if (domain.includes("novelnext")) return { name: "NovelNext", scraper: scrapeGeneric };
    if (domain.includes("novelcool")) return { name: "NovelCool", scraper: scrapeGeneric };

  return { name: "Generic", scraper: scrapeGeneric };
}

// ---- FETCH NOVEL INFO ----
async function fetchNovelInfo(url) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    };

    const { data } = await axios.get(url, { 
      headers, 
      timeout: 8000,
      validateStatus: () => true 
    });
    const $ = cheerio.load(data);

    let title = $("h1").first().text().trim() || "Novel";
    let description = "";
    let coverImage = "";

    // Extract description
    const descSelectors = [
      ".novel-intro",
      ".description",
      "[class*='desc']",
      ".synopsis",
      ".summary"
    ];

    for (const selector of descSelectors) {
      const text = $(selector).text().trim();
      if (text && text.length > 20) {
        description = text.substring(0, 300);
        break;
      }
    }

    // Extract cover image
    const coverSelectors = [
      "meta[property='og:image']",
      "meta[name='twitter:image']",
      "img[class*='cover']",
      "img[class*='poster']",
      ".novel-cover img",
      ".book-cover img",
      ".book-img img",
      "img[alt*='cover']",
      "img[src*='cover']",
      ".book-img > img",
      ".poster-img"
    ];

    for (const selector of coverSelectors) {
      let src = "";
      if (selector.startsWith("meta")) {
        src = $(selector).attr("content");
      } else {
        const el = $(selector);
        src = el.attr("src") || el.attr("data-src") || el.attr("data-original");
      }

      if (src && src.trim() && !src.includes("placeholder")) {
        try {
          coverImage = src.startsWith("http") ? src : new URL(src, url).href;
          // Clean URL (remove some common thumb suffixes or query params)
          coverImage = coverImage.split('?')[0]; 
          break;
        } catch (e) {
          coverImage = "";
        }
      }
    }

    // Extract total chapters
    let chapterCount = 0;
    const countSelectors = [
      ".chapter-count",
      ".num-chapters",
      ".chapters-number",
      ".novel-detail-item:contains('Chapters')",
      ".book-info-item:contains('Chapters')"
    ];

    for (const sel of countSelectors) {
      const text = $(sel).text().toLowerCase();
      const match = text.match(/(\d+)/);
      if (match) {
        chapterCount = parseInt(match[1]);
        break;
      }
    }

    if (chapterCount === 0) {
      // Look for last chapter link
      const lastChapter = $("a:contains('Chapter')").last().text();
      const match = lastChapter.match(/Chapter\s+(\d+)/i);
      if (match) chapterCount = parseInt(match[1]);
    }

    return { title, description: description || "No description available", coverImage, chapterCount };
  } catch (err) {
    console.error("fetchNovelInfo error:", err.message);
    return { 
      title: "Novel", 
      description: "Unable to fetch description", 
      coverImage: "",
      chapterCount: 0
    };
  }
}

// Helper function to create progress bar
function createProgressBar(current, total, width = 20) {
  const percentage = Math.round((current / total) * 100);
  const filledWidth = Math.round((width * current) / total);
  const emptyWidth = width - filledWidth;
  const bar = "█".repeat(filledWidth) + "░".repeat(emptyWidth);
  return `${bar} ${percentage}%`;
}

// Helper function to format time
function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ---- PROCESS NOVEL (after chapter count selected) ----
async function processNovel(chatId, novelUrl, chapterLimit, infoMsg = null) {
  const { name: siteName, scraper } = detectSite(novelUrl);

  const processingMsg = infoMsg || await bot.sendMessage(
    chatId,
    `⏳ Connecting to *${siteName}*...\n\n_Discovering chapters..._`,
    { parse_mode: "Markdown" }
  );

  try {
    console.log(`[${new Date().toISOString()}] Scraping from ${siteName}: ${novelUrl}`);

    let startTime = Date.now();
    let lastUpdateTime = startTime;

    const { novelTitle: scrapedTitle, chapters } = await scraper(novelUrl, chapterLimit, async (current, total) => {
      const now = Date.now();
      if (now - lastUpdateTime < 2000) return; // Update every 2 seconds
      
      lastUpdateTime = now;
      const progress = createProgressBar(current, total);
      const elapsed = (now - startTime) / 1000;
      const speed = current / elapsed; // chapters per second
      const remaining = total - current;
      
      // Better ETA calculation
      let etaText = "calculating...";
      if (speed > 0) {
        const remainingSeconds = remaining / speed;
        etaText = formatTime(remainingSeconds);
      }
      
      try {
        await bot.editMessageText(
          `🚀 *Scraping Chapters...*\n\n` +
          `📖 *${siteName}*\n` +
          `📊 Progress: ${current}/${total}\n` +
          `⏳ ${progress}\n` +
          `⏱️ ETA: ${etaText}`,
          { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: "Markdown" }
        );
      } catch (e) {
        // Ignore message unchanged error or throttling
      }
    });

    console.log(`Scraper returned title: "${scrapedTitle}" and ${chapters?.length || 0} chapters`);

    // CRITICAL FIX: Ensure we don't use "404 Not Found" as the title
    let novelTitle = scrapedTitle;
    if (!novelTitle || novelTitle.toLowerCase().includes("404") || novelTitle.toLowerCase().includes("not found")) {
      const { title: infoTitle } = await fetchNovelInfo(novelUrl);
      novelTitle = infoTitle;
    }

    // Final fallback if still 404
    if (!novelTitle || novelTitle.toLowerCase().includes("404") || novelTitle.toLowerCase().includes("not found")) {
      novelTitle = siteName + " Novel";
    }

    if (!chapters || chapters.length === 0) {
      throw new Error("No chapters found. The website structure might have changed.");
    }

    console.log(`Found ${chapters.length} chapters for "${novelTitle}"`);

    // Creating EPUB
    if (infoMsg) {
      await bot.editMessageText(
        `⏳ Creating EPUB...\n\n📖 *${novelTitle}*\n\nChapters: ${chapters.length}`,
        { chat_id: chatId, message_id: infoMsg.message_id, parse_mode: "Markdown" }
      );
    }

    const epubPath = await createEpub(novelTitle, "Web Novel", chapters);
    const fileSizeKB = (fs.statSync(epubPath).size / 1024).toFixed(2);
    const totalTime = formatTime((Date.now() - startTime) / 1000);

    if (infoMsg) {
      await bot.editMessageText(
        `✅ EPUB Ready!\n\n📖 *${novelTitle}*\n` +
        `📊 Chapters: ${chapters.length}\n` +
        `💾 Size: ~${fileSizeKB} KB\n` +
        `⏱️ Time: ${totalTime}`,
        { chat_id: chatId, message_id: infoMsg.message_id, parse_mode: "Markdown" }
      );
    }

    await bot.sendDocument(chatId, epubPath, {
      caption: `✅ *EPUB Ready!*\n\n` +
        `📖 *${novelTitle}*\n\n` +
        `📦 Download complete!\n` +
        `💾 Open in your EPUB reader\n\n` +
        `👉 Send another URL to convert another novel!`,
      parse_mode: "Markdown"
    }, {
      filename: `${novelTitle}.epub`,
      contentType: 'application/epub+zip'
    });

    // Save to library
    try {
      const { coverImage, description } = await fetchNovelInfo(novelUrl);
      const fileSize = fs.statSync(epubPath).size;
      await saveEpub(chatId, novelTitle, "Unknown", novelUrl, chapters.length, epubPath, fileSize, coverImage, description);
      console.log(`✅ EPUB saved to library for user ${chatId}`);
    } catch (dbErr) {
      console.log(`⚠️ Could not save to library: ${dbErr.message}`);
    }

    // Clean up temp file
    setTimeout(() => {
      try { fs.unlinkSync(epubPath); } catch (e) {}
    }, 5000);

    console.log(`✅ Successfully sent EPUB for "${novelTitle}"`);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] EPUB ERROR:`, err.message);

    const errorMsg = err.message.includes("timeout") 
      ? "❌ Connection timeout. The website might be blocking requests or slow to respond."
      : err.message.includes("No chapters")
      ? "❌ Could not find chapters. This site might not be supported or the URL might be incorrect."
      : `❌ Failed to create EPUB\n\n_Error: ${err.message.substring(0, 100)}_`;

    if (infoMsg) {
      await bot.editMessageText(
        errorMsg,
        { chat_id: chatId, message_id: infoMsg.message_id, parse_mode: "Markdown" }
      );
    } else {
      await bot.sendMessage(chatId, errorMsg, { parse_mode: "Markdown" });
    }
  }
}

// ---- COMMANDS ----
bot.onText(/\/start/, async (msg) => {
  const welcomeMessage = "✨ *Welcome to WebNovel EPUB Bot* ✨";
  const helpMessage = 
    "I'm your personal library assistant! I can fetch web novels and turn them into beautiful EPUBs for your Kindle, iPad, or e-reader.\n\n" +
    "🚀 *Getting Started:*\n" +
    "1️⃣ *Send me a link* from any supported site\n" +
    "2️⃣ *Choose your range* using the buttons\n" +
    "3️⃣ *Get your book* instantly!\n\n" +
    "👇 *Tap a button below to explore:*";

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "📚 My Library" }, { text: "🌐 Supported Sites" }],
        [{ text: "⚡️ Search Novel" }, { text: "ℹ️ About" }, { text: "❓ Help" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    },
    parse_mode: "Markdown"
  };

  try {
    await bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: "Markdown" });
    await bot.sendMessage(msg.chat.id, helpMessage, keyboard);
  } catch (err) {
    console.error("Error in /start command:", err.message);
  }
});

// Handle Reply Keyboard buttons
bot.on("message", async (msg) => {
  if (!msg.text) return;
  
  const chatId = msg.chat.id;
  
  switch (msg.text) {
    case "📚 My Library":
      return bot.emit("text", { ...msg, text: "/library" });
    case "🌐 Supported Sites":
      return bot.emit("text", { ...msg, text: "/sites" });
    case "⚡️ Search Novel":
      return bot.sendMessage(chatId, "🔍 *Search Feature Coming Soon!*\n\nFor now, please paste a direct novel URL from one of our supported sites.", { parse_mode: "Markdown" });
    case "ℹ️ About":
      return bot.emit("text", { ...msg, text: "/about" });
    case "❓ Help":
      return bot.emit("text", { ...msg, text: "/help" });
  }
});

bot.onText(/\/sites/, async (msg) => {
  const sitesList = 
    "🌐 *Supported Websites*\n\n" +
    "✅ *Premium Support (Fast/Cover/Info):*\n" +
    "• Royal Road\n" +
    "• WebNovel\n" +
    "• Wattpad\n" +
    "• FreeWebNovel\n" +
    "• ReadLightNovel\n" +
    "• NovelFull\n" +
    "• MTLNovel\n" +
    "• Wuxiaworld\n" +
    "• ScribbleHub\n" +
    "• FanFiction.net\n" +
    "• Archive of Our Own (AO3)\n" +
    "• BoxNovel\n\n" +
    "✨ *Generic Support (100+ sites):*\n" +
    "• NovelHall, NovelNext, NovelCool, etc.\n\n" +
    "_Just paste any novel link to try!_";

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "📚 My Library" }, { text: "🌐 Supported Sites" }],
        [{ text: "⚡️ Search Novel" }, { text: "ℹ️ About" }, { text: "❓ Help" }]
      ],
      resize_keyboard: true
    },
    parse_mode: "Markdown"
  };

  try {
    await bot.sendMessage(msg.chat.id, sitesList, keyboard);
  } catch (err) {
    console.error("Error in /sites command:", err.message);
  }
});

bot.onText(/\/about/, async (msg) => {
  const aboutText = 
    "🤖 *WebNovel EPUB Bot v1.1.0*\n\n" +
    "This bot is your ultimate companion for reading web novels offline. It scrapes content directly from the web and converts it into high-quality, formatted EPUB files.\n\n" +
    "🚀 *Features:*\n" +
    "• *Lightning Fast:* Concurrent scraping technology.\n" +
    "• *Personal Library:* Save and manage your books.\n" +
    "• *Multi-Site:* Supports 14+ major sites + 100s via generic engine.\n" +
    "• *Smart Formatting:* Clean text, no ads, proper chaptering.\n\n" +
    "🛠️ *Powered by Node.js, Playwright & PostgreSQL*";
  
  try {
    await bot.sendMessage(msg.chat.id, aboutText, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Error in /about command:", err.message);
  }
});

bot.onText(/\/help/, async (msg) => {
  const helpText = 
    "❓ *Need Help?*\n\n" +
    "1️⃣ *How to use:* Simply copy a link to a novel (e.g., from RoyalRoad or NovelFull) and paste it here.\n\n" +
    "2️⃣ *Range Selection:* After pasting, you can choose to download the whole book or a specific range of chapters.\n\n" +
    "3️⃣ *My Library:* Use the button to see all your previously downloaded novels. You can re-download or update them from there.\n\n" +
    "4️⃣ *Updates:* If a novel has new chapters, go to your Library and tap 'Update'.\n\n" +
    "⚠️ *Note:* Some sites use heavy protection. If a link fails, wait a few minutes or try another site.";

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "📚 My Library" }, { text: "🌐 Supported Sites" }],
        [{ text: "⚡️ Search Novel" }, { text: "ℹ️ About" }, { text: "❓ Help" }]
      ],
      resize_keyboard: true
    },
    parse_mode: "Markdown"
  };

  try {
    await bot.sendMessage(msg.chat.id, helpText, keyboard);
  } catch (err) {
    console.error("Error in /help command:", err.message);
  }
});

bot.onText(/\/library/, async (msg) => {
  const userId = msg.chat.id;
  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "📚 My Library" }, { text: "🌐 Supported Sites" }],
        [{ text: "⚡️ Search Novel" }, { text: "ℹ️ About" }, { text: "❓ Help" }]
      ],
      resize_keyboard: true
    }
  };

  try {
    const epubs = await getUserLibrary(userId);
    const totalSize = await getLibrarySize(userId);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);

    if (epubs.length === 0) {
      await bot.sendMessage(userId, 
        "📚 *Your Library is Empty*\n\n" +
        "Start by sending a novel URL to create your first EPUB!",
        { ...keyboard, parse_mode: "Markdown" }
      );
      return;
    }

    await bot.sendMessage(userId, `📚 *Your EPUB Library*\n📊 ${epubs.length} books | 💾 ${sizeMB} MB`, { ...keyboard, parse_mode: "Markdown" });

    for (const epub of epubs) {
      const date = new Date(epub.created_at).toLocaleDateString();
      const caption = `📖 *${epub.title}*\n📄 ${epub.chapters_count} chapters\n📅 ${date}`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "⬇️ Download", callback_data: `dl_${epub.id}` },
            { text: "🔄 Update", callback_data: `up_${epub.id}` },
            { text: "🗑 Delete", callback_data: `del_${epub.id}` }
          ]
        ]
      };

      if (epub.cover_url) {
        try {
          await bot.sendPhoto(userId, epub.cover_url, {
            caption: caption,
            parse_mode: "Markdown",
            reply_markup: keyboard
          });
        } catch (e) {
          await bot.sendMessage(userId, caption, {
            parse_mode: "Markdown",
            reply_markup: keyboard
          });
        }
      } else {
        await bot.sendMessage(userId, caption, {
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
      }
    }
  } catch (err) {
    console.error("Library error:", err.message);
    await bot.sendMessage(userId, "❌ Error loading library. Try again later.");
  }
});

// Helper for download/update/delete callback handling
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("dl_")) {
    const id = data.split("_")[1];
    const epub = await getEpubById(id, chatId);
    if (epub && fs.existsSync(epub.file_path)) {
      await bot.sendDocument(chatId, epub.file_path, { caption: `📖 *${epub.title}*` });
    } else {
      await bot.answerCallbackQuery(query.id, "❌ File not found. You might need to re-scrape it.", true);
    }
  } else if (data.startsWith("up_")) {
    const id = data.split("_")[1];
    const epub = await getEpubById(id, chatId);
    if (epub && epub.source_url) {
      await bot.answerCallbackQuery(query.id, "🔄 Starting update...", false);
      // Logic for updating (usually scraping from where it left off, but here we just re-scrape full for simplicity)
      await processNovel(chatId, epub.source_url, 999);
    }
  } else if (data.startsWith("del_")) {
    const id = data.split("_")[1];
    const result = await deleteEpub(id, chatId);
    if (result) {
      if (result.file_path && fs.existsSync(result.file_path)) {
        try { fs.unlinkSync(result.file_path); } catch(e) {}
      }
      await bot.deleteMessage(chatId, query.message.message_id);
      await bot.answerCallbackQuery(query.id, "✅ Deleted from library");
    }
  }
});

bot.onText(/\/help/, async (msg) => {
  await bot.onText(/\/start/, msg);
});

// ---- URL DETECTION IN MESSAGES ----
bot.on("message", async msg => {
  if (!msg.text) return;

  // Check if message contains a URL
  const urlMatch = msg.text.match(/https?:\/\/[^\s]+/);

  if (urlMatch) {
    const novelUrl = urlMatch[0];
    const chatId = msg.chat.id;

    // Validate URL
    try {
      new URL(novelUrl);
    } catch (e) {
      await bot.sendMessage(chatId, "❌ Invalid URL.");
      return;
    }

    const { name: siteName } = detectSite(novelUrl);

    // Fetch novel info with spinning animation
    const loadingMsg = await bot.sendMessage(chatId, `⏳ Fetching info from *${siteName}*...`, { parse_mode: "Markdown" });

    const { title: scrapedTitle, description, coverImage, chapterCount } = await fetchNovelInfo(novelUrl);
    const title = scrapedTitle === "404 Not Found" ? (detectSite(novelUrl).name + " Novel") : scrapedTitle;

    // Store URL in session and get short ID
    const sessionId = storeNovelURL(novelUrl);

    // Create caption with better formatting (compact like old bot)
    let caption = `📖 *${title}*\n` +
      `📊 Chapters: ${chapterCount || "???"}\n` +
      `🔗 [Source](${novelUrl})\n\n` +
      `*Synopsis:*\n${description.length > 150 ? description.substring(0, 150) + "..." : description}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "📚 Scrape All", callback_data: `sc_999_${sessionId}` },
          { text: "✂️ Range", callback_data: `cr_${sessionId}` }
        ]
      ]
    };

    try {
      if (coverImage) {
        await bot.sendPhoto(chatId, coverImage, {
          caption: caption,
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
        await bot.deleteMessage(chatId, loadingMsg.message_id);
      } else {
        await bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
      }
    } catch (err) {
      console.error("Error sending novel info:", err.message);
      // Fallback to text if photo fails
      try {
        await bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: "Markdown",
          reply_markup: keyboard
        });
      } catch (e) {
        await bot.sendMessage(chatId, "❌ Error loading novel. Try again.", { parse_mode: "Markdown" });
      }
    }
  } else if (msg.text && !msg.text.startsWith("/")) {
    const chatId = msg.chat.id;

    // Check if we're waiting for a custom chapter count
    const waiting = getWaitingForRange(chatId);
    if (waiting) {
      const chapterCount = parseInt(msg.text);
      if (!isNaN(chapterCount) && chapterCount > 0) {
        clearWaitingForRange(chatId);
        const novelUrl = getNovelURL(waiting.sessionId);

        if (novelUrl) {
          const limit = Math.min(chapterCount, 200); // Max 200 chapters
          const processingMsg = await bot.sendMessage(chatId, 
            `🚀 *Starting conversion...*\n\n` +
            `📊 Scraping: ${limit} chapters\n` +
            `⟳ This may take a few minutes...\n\n` +
            `_Progress updates below:_`,
            { parse_mode: "Markdown" }
          );
          await processNovel(chatId, novelUrl, limit, processingMsg);
        } else {
          await bot.sendMessage(chatId, "❌ Session expired. Please send the novel URL again.");
        }
      } else {
        await bot.sendMessage(chatId, 
          "❌ *Invalid input!*\n\n" +
          "Please send a number between 1-200\n\n" +
          "Example: `50`",
          { parse_mode: "Markdown" }
        );
      }
    } else {
      await bot.sendMessage(chatId, 
        "💬 *Need help?*\n\n" +
        "Send a novel URL like:\n" +
        "`https://royalroad.com/fiction/...`\n\n" +
        "Or use /start for full instructions",
        { parse_mode: "Markdown" }
      );
    }
  }
});

// ---- CALLBACK QUERY HANDLER (button clicks) ----
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Handle custom range button: cr_s_123
  if (data.startsWith("cr_")) {
    const sessionId = data.substring(3);
    setWaitingForRange(chatId, sessionId, query.message.message_id);
    await bot.answerCallbackQuery(query.id, "✅ Enter chapter count", false);
    await bot.sendMessage(chatId, 
      "📝 *How many chapters do you want?*\n\n" +
      "Send a number between 1-200\n\n" +
      "Examples:\n" +
      "• `50` → First 50 chapters\n" +
      "• `100` → First 100 chapters\n" +
      "• `200` → First 200 chapters",
      { parse_mode: "Markdown" }
    );
  }
  // Handle all chapters or preset: sc_999_s_123
  else if (data.startsWith("sc_")) {
    const parts = data.split("_");
    const chapterLimit = parseInt(parts[1]);
    const sessionId = parts.slice(2).join("_");

    // Get URL from session
    const novelUrl = getNovelURL(sessionId);

    if (!novelUrl) {
      await bot.answerCallbackQuery(query.id, "❌ Session expired. Please send the URL again.", true);
      return;
    }

    // Acknowledge button click
    await bot.answerCallbackQuery(query.id, "⏳ Starting to scrape...", false);

    // Process the novel
    const processingMsg = query.message;
    await processNovel(chatId, novelUrl, chapterLimit, processingMsg);
  }
});

console.log("✅ Bot initialized and polling started");
