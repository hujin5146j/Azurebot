const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const cheerio = require("cheerio");
const Epub = require("epub-gen");
const fs = require("fs");
const path = require("path");

// --- Token ---
const token = process.env.TELEGRAM_BOT_TOKEN || "PUT-YOUR-TOKEN-HERE";
if (!token || token === "PUT-YOUR-TOKEN-HERE") {
  console.error("❌ TELEGRAM_BOT_TOKEN not set.");
  process.exit(1);
}

console.log('🔧 Initializing Telegram Bot...');
const bot = new TelegramBot(token, { 
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});
console.log('✅ Bot instance created');

let userStates = {};

// Error handling for polling
bot.on('polling_error', (error) => {
  console.error('❌ POLLING ERROR:', error.code, error.message);
  if (error.code === 'EFATAL' || error.code === 'ETELEGRAM') {
    console.error('Fatal error - exiting...');
    process.exit(1);
  }
});

console.log('🚀 Bot is ready!');

// --- Escape Markdown ---
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
}

// --- Advanced headers for bypassing blocks ---
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

function getBrowserHeaders(url) {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const isMobile = userAgent.includes('iPhone') || userAgent.includes('Android');

  return {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    ...(url && { 'Referer': url })
  };
}

// --- Rate limiter ---
const limiter = {
  running: 0,
  maxConcurrent: 12,
  minDelayMs: 50,
  lastStart: 0
};

async function rateLimit() {
  while (limiter.running >= limiter.maxConcurrent) {
    await new Promise(r => setTimeout(r, 50));
  }
  const since = Date.now() - limiter.lastStart;
  if (since < limiter.minDelayMs) {
    await new Promise(r => setTimeout(r, limiter.minDelayMs - since));
  }
  limiter.running++;
  limiter.lastStart = Date.now();
  return () => { limiter.running = Math.max(0, limiter.running - 1); };
}

// --- Helpers ---
function buildProgress(current, total) {
  const percent = Math.floor((current / total) * 100);
  const filledBlocks = Math.floor((percent / 100) * 15);
  return `⏳ [${"■".repeat(filledBlocks)}${"□".repeat(15 - filledBlocks)}] ${percent}% (${current}/${total})`;
}

function formatETA(msLeft) {
  const sec = Math.ceil(msLeft / 1000);
  if (sec < 5) return "⚡ Almost done…";
  if (sec < 60) return `⏱ ~${sec}s remaining`;
  const minutes = Math.floor(sec / 60);
  return `⏱ ~${minutes}m ${sec % 60}s remaining`;
}

function sanitizeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, "_").substring(0, 100);
}

// --- Library helpers ---
const LIBRARY_FILE = path.join(__dirname, "library.json");
const EPUB_DIR = path.join(__dirname, "epubs");

// Create EPUB directory
if (!fs.existsSync(EPUB_DIR)) {
  fs.mkdirSync(EPUB_DIR, { recursive: true });
}

function loadLibrary() {
  if (!fs.existsSync(LIBRARY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch (err) {
    console.error('⚠️ Library load error:', err.message);
    return {};
  }
}

async function saveLibrary(library) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error(`Library save error (attempt ${attempt}):`, err.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  return false;
}

// --- Advanced WebNovel API fetcher ---
async function tryWebNovelAPI(bookId) {
  const apiEndpoints = [
    `https://www.webnovel.com/apiajax/chapter/GetChapterList?bookId=${bookId}`,
    `https://www.webnovel.com/api/v1/books/${bookId}/chapters`,
    `https://m.webnovel.com/apiajax/chapter/GetChapterList?bookId=${bookId}`,
  ];

  for (const apiUrl of apiEndpoints) {
    try {
      console.log(`🔍 Trying WebNovel API: ${apiUrl}`);
      const response = await axios.get(apiUrl, {
        headers: getBrowserHeaders(`https://www.webnovel.com/book/${bookId}`),
        timeout: 10000,
        validateStatus: () => true
      });

      console.log(`📊 API Response - Status: ${response.status}, Has Data: ${!!response.data}`);

      if (response.status === 200 && response.data) {
        // Log the data structure to understand what we're getting
        const dataKeys = Object.keys(response.data);
        console.log(`✅ API returned data with keys: ${dataKeys.join(', ')}`);

        // Check if it has chapter data
        if (response.data.data?.chapterItems || response.data.data?.volumeItems || response.data.chapters) {
          console.log(`✅ API has chapter data!`);
          return response.data;
        } else {
          console.log(`⚠️ API response missing chapter data. Keys: ${dataKeys.join(', ')}`);
        }
      } else {
        console.log(`⚠️ API failed - Status: ${response.status}`);
      }
    } catch (err) {
      console.log(`❌ API request error: ${err.message}`);
    }
  }

  console.log('❌ All API endpoints failed or returned no chapter data');
  return null;
}

// --- Request helper with retries ---
async function fetchWithRetry(url, retries = 3) {
  const release = await rateLimit();
  let lastErr;

  for (let i = 0; i < retries; i++) {
    try {
      const headers = getBrowserHeaders(url);

      const res = await axios.get(url, {
        headers,
        timeout: 15000,
        maxRedirects: 5,
      });
      release();
      return res;
    } catch (err) {
      lastErr = err;
      console.log(`⚠️ Fetch attempt ${i + 1}/${retries} failed for ${url}: ${err.message}`);
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  release();
  throw lastErr;
}

// --- Chapter content extractor ---
function extractChapterContent($) {
  $("script, style, iframe, noscript, form, header, footer, nav, aside").remove();
  $(".ad, .ads, .advertisement, .comment, .comments, .navigation, .sidebar").remove();

  const selectors = [
    "#chapter-content",
    "#chr-content",
    ".chapter-content",
    ".chapter-text",
    ".reading-content",
    ".entry-content",
    ".post-content",
    ".novel-content",
    "article",
    "main",
  ];

  let $root = null;
  let bestLength = 0;

  for (const sel of selectors) {
    const node = $(sel).first();
    if (node.length) {
      const textLength = node.text().trim().length;
      if (textLength > bestLength && textLength > 300) {
        bestLength = textLength;
        $root = node;
      }
    }
  }

  if (!$root) {
    $root = $("article, body").first();
  }

  let paragraphs = $root.find("p").map((i, el) => $(el).text().trim()).get();

  if (paragraphs.length < 3) {
    let html = $root.html() || "";
    html = html.replace(/<br\s*\/?>/gi, "\n");
    paragraphs = html
      .split("\n")
      .map(line => line.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
  }

  const badPatterns = [
    /(previous|next)\s+chapter/i,
    /advertisement/i,
    /report\s+error/i,
    /tip:|donate/i,
    /use\s+arrow\s+keys/i,
    /bookmark/i,
    /subscribe|premium|vip/i,
  ];

  paragraphs = paragraphs.filter(p => {
    if (!p || p.length < 30) return false;
    return !badPatterns.some(pattern => pattern.test(p));
  });

  paragraphs = paragraphs
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 20)
    .map(p => `<p style="margin:0 0 1em 0;text-align:justify;line-height:1.6;">${p}</p>`);

  const content = paragraphs.join("");

  if (content.length < 200) {
    return "<p style='color:#ff6b6b;text-align:center;font-style:italic;'>⚠️ No readable content found.</p>";
  }

  return content;
}

// --- Chapter link detection ---
function detectChapterLinks($, baseUrl) {
  let chapterLinks = [];
  const seenUrls = new Set();

  $("a").each((i, el) => {
    const $link = $(el);
    const href = $link.attr("href");
    const linkText = $link.text().trim();

    if (!href || !linkText) return;

    const chapterPatterns = [
      /chapter\s*(\d+)/i,
      /ch\.?\s*(\d+)/i,
      /episode\s*(\d+)/i,
      /ep\.?\s*(\d+)/i,
      /^(\d+)\s+\w/,  // WebNovel format: "1 Crimson", "2 Situation"
      /^\s*(\d+)\s*$/,
    ];

    let chapterNumber = null;
    let isChapterLink = false;

    for (const pattern of chapterPatterns) {
      const match = linkText.match(pattern);
      if (match) {
        chapterNumber = parseInt(match[1]);
        isChapterLink = true;
        break;
      }
    }

    if (!isChapterLink) return;

    let fullUrl = href;
    if (!href.startsWith('http')) {
      try {
        fullUrl = new URL(href, baseUrl).href;
      } catch (e) {
        return;
      }
    }

    if (seenUrls.has(fullUrl)) return;
    seenUrls.add(fullUrl);

    chapterLinks.push({
      title: linkText,
      url: fullUrl,
      num: chapterNumber || chapterLinks.length + 1
    });
  });

  chapterLinks.sort((a, b) => a.num - b.num);
  return chapterLinks;
}

// --- Start command ---
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 **Welcome to Novel Scraper Bot\\!**\n\n📖 I convert web novels into beautiful EPUB files for offline reading\\.\n\n**📝 How to use:**\n1\\. Send me a novel URL\n2\\. Choose chapters to scrape\n3\\. Download your EPUB\\!\n\n**⚡ Commands:**\n• `/mybooks` \\- Your library\n• `/clear` \\- New session\n\n**🌐 Supported sites:**\n• WebNovel \\(auto\\-detection\\)\n• Royal Road\n• Novel Updates  \n• FreeWebNovel\n• \\.\\.\\. and more\\!\n\n*Ready\\? Send me a novel URL to begin\\!* 🚀",
    { parse_mode: 'MarkdownV2' }
  );
});

// --- Library command ---
bot.onText(/\/mybooks/, (msg) => {
  const chatId = msg.chat.id;
  const library = loadLibrary();
  const books = library[chatId] || [];

  if (!books.length) {
    bot.sendMessage(chatId, "📚 **Your Library is Empty**\n\nYou haven't saved any books yet\\!\n\n💡 *Tip:* Send me a novel URL to create your first EPUB\\.", 
      { parse_mode: 'MarkdownV2' });
    return;
  }

  bot.sendMessage(chatId, `📚 **Your Library** \\(${books.length} ${books.length === 1 ? 'book' : 'books'}\\)`, 
    { parse_mode: 'MarkdownV2' });

  books.forEach((b, i) => {
    const buttons = [
      [{ text: "⬇️ Download", callback_data: `download_${i}` }],
      [
        { text: "🔄 Update", callback_data: `update_${i}` },
        { text: "🗑 Delete", callback_data: `delete_${i}` }
      ]
    ];

    const caption = `📖 *${escapeMarkdown(b.title)}*\n📊 ${b.chapters} chapters`;

    if (b.coverUrl) {
      bot.sendPhoto(chatId, b.coverUrl, {
        caption,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      }).catch(() => {
        bot.sendMessage(chatId, caption, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: buttons },
        });
      });
    } else {
      bot.sendMessage(chatId, caption, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });
    }
  });
});

// --- Reset session ---
bot.onText(/\/clear/, (msg) => {
  delete userStates[msg.chat.id];
  bot.sendMessage(msg.chat.id, "✨ **Session Cleared\\!**\n\nYou're ready for a fresh start\\. Send me a novel URL to begin\\!", 
    { parse_mode: 'Markdown' });
});

// --- Handle messages (URL scraping) ---
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return;

  // Handle chapter count input for WebNovel
  if (userStates[chatId]?.awaitingChapterCount) {
    const totalChapters = parseInt(text);

    if (isNaN(totalChapters) || totalChapters < 1) {
      bot.sendMessage(chatId, "⚠️ **Invalid Number**\n\nPlease send a valid chapter count\\.\n\n*Example:* `2630`", 
        { parse_mode: 'Markdown' });
      return;
    }

    const state = userStates[chatId];
    const chapterId = state.sampleChapterId;
    const chapterNum = state.sampleChapterNum;
    const increment = chapterNum > 1 ? (chapterId - BigInt(0)) / BigInt(chapterNum - 1) : BigInt(100);

    bot.sendMessage(chatId, `🧮 **Generating Chapter URLs**\n\nCreating ${totalChapters} chapter links\\.\\.\\.\n⏳ *Please wait*`, 
      { parse_mode: 'Markdown' });

    // Generate all chapter URLs
    const chapterLinks = [];
    for (let i = 1; i <= totalChapters; i++) {
      const generatedId = chapterId + (BigInt(i - chapterNum) * increment);
      chapterLinks.push({
        title: `Chapter ${i}`,
        url: `${state.baseBookUrl}/${generatedId}`,
        num: i
      });
    }

    console.log(`✅ Generated ${chapterLinks.length} chapter URLs with user-provided count`);

    // Clear learning state and set up for scraping
    userStates[chatId] = {
      novelUrl: state.baseBookUrl,
      chapterLinks,
      novelTitle: state.novelTitle,
      coverUrl: state.coverUrl
    };

    const previewText = `✅ *Pattern Learned\\!*\n\n📖 ${escapeMarkdown(state.novelTitle)}\n📊 Generated *${chapterLinks.length}* chapter URLs\n\nChoose how to proceed:`;

    const keyboard = [
      [{ text: "📚 Scrape All Chapters", callback_data: "scrape_all" }],
      [{ text: "✂️ Choose Range", callback_data: "choose_range" }],
      [{ text: "🔍 Preview First Chapter", callback_data: "preview_first" }]
    ];

    bot.sendMessage(chatId, previewText, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });

    return;
  }

  // Handle WebNovel pattern learning
  if (userStates[chatId]?.learningWebNovel) {
    const state = userStates[chatId];

    // Check if user sent a chapter URL
    if (!/^https?:\/\//i.test(text) || !isActualWebNovel(text)) {
      bot.sendMessage(chatId, "⚠️ Please send a WebNovel chapter URL (starts with https://www.webnovel.com or https://m.webnovel.com)");
      return;
    }

    // Extract chapter ID from URL - handle ALL formats
    // Formats seen:
    // /book/bookid/chapterid
    // /book/bookid/chapter-title_chapterid
    // /book/bookid_chapterid
    // The chapter ID is always a long number (10+ digits) at the end

    const chapterIdMatch = text.match(/[_\/](\d{10,})(?:[?#].*)?$/);  // Match _ or / before long number at end

    if (!chapterIdMatch) {
      bot.sendMessage(chatId, "⚠️ Couldn't extract chapter ID from URL.\n\nPlease send a chapter page URL like:\n• https://www.webnovel.com/book/123/456789...\n• https://www.webnovel.com/book/123/title_456789...");
      return;
    }

    // Try to extract chapter number from URL (optional, for reference)
    const chapterNumMatch = text.match(/Chapter[_\s-]+(\d+)|ch[_\s-](\d+)|\/c?(\d+)[_-]/i);

    const chapterId = BigInt(chapterIdMatch[1]);
    const chapterNum = chapterNumMatch ? parseInt(chapterNumMatch[1] || chapterNumMatch[2] || chapterNumMatch[3]) : 1;

    bot.sendMessage(chatId, `✅ Chapter ID extracted: ${chapterId}\n🔍 Auto-detecting total chapters...`);

    // Try to get total chapters from the chapter page
    let totalChapters = state.totalChapters;

    if (totalChapters === 0) {
      // Strategy 1: Fetch the sample chapter page
      try {
        const chapterRes = await fetchWithRetry(text, 2);
        const $chapter = cheerio.load(chapterRes.data);
        const chapterCountMatch = 
          chapterRes.data.match(/Chapter\s+(\d+):/i) ||
          chapterRes.data.match(/(\d+)\s*chapters/i) ||
          chapterRes.data.match(/"chapterCount["\s:]+(\d+)/) ||
          chapterRes.data.match(/Total.*?(\d+)/i);

        if (chapterCountMatch) {
          totalChapters = parseInt(chapterCountMatch[1]);
          console.log(`✅ Found total chapters from chapter page: ${totalChapters}`);
          bot.sendMessage(chatId, `✅ Auto-detected ${totalChapters} total chapters!`);
        }
      } catch (e) {
        console.log(`⚠️ Couldn't fetch chapter page: ${e.message}`);
      }

      // Strategy 2: Try to fetch the main book page again with the chapter as referer
      if (totalChapters === 0) {
        try {
          console.log('🔍 Trying main page with chapter as referer...');
          const bookRes = await axios.get(state.baseBookUrl, {
            headers: {
              ...getBrowserHeaders(state.baseBookUrl),
              'Referer': text
            },
            timeout: 10000,
            validateStatus: () => true
          });

          if (bookRes.status === 200) {
            const chapterCountMatch = 
              bookRes.data.match(/Chapter\s+(\d+):/i) ||
              bookRes.data.match(/(\d+)\s*Chs/i) ||
              bookRes.data.match(/(\d+)\s*chapters/i);

            if (chapterCountMatch) {
              totalChapters = parseInt(chapterCountMatch[1]);
              console.log(`✅ Found total chapters from main page: ${totalChapters}`);
              bot.sendMessage(chatId, `✅ Auto-detected ${totalChapters} total chapters!`);
            }
          }
        } catch (e) {
          console.log(`⚠️ Couldn't fetch main page: ${e.message}`);
        }
      }
    }

    // If still don't know, ask user
    if (totalChapters === 0) {
      userStates[chatId].awaitingChapterCount = true;
      userStates[chatId].sampleChapterId = chapterId;
      userStates[chatId].sampleChapterNum = chapterNum;

      bot.sendMessage(chatId, `✅ Pattern detected\\!\n\n• Chapter: ${chapterNum}\n• Chapter ID: ${chapterId}\n\n❓ **How many chapters does this novel have in total?**\n\nJust reply with the number \\(e.g\\. 2630\\)`, { parse_mode: 'Markdown' });
      return;
    }

    bot.sendMessage(chatId, `🧮 Learning pattern...\n\nDetected:\n• Chapter: ${chapterNum}\n• Chapter ID: ${chapterId}\n• Total Chapters: ${totalChapters}\n\nGenerating ${totalChapters} chapter URLs...`);

    // Calculate increment (assume linear pattern)
    // If we don't know which chapter this is, assume it's chapter 1
    const increment = chapterNum > 1 ? (chapterId - BigInt(0)) / BigInt(chapterNum - 1) : BigInt(100);  // fallback guess

    // Generate all chapter URLs
    const chapterLinks = [];
    for (let i = 1; i <= totalChapters; i++) {
      const generatedId = chapterId + (BigInt(i - chapterNum) * increment);
      chapterLinks.push({
        title: `Chapter ${i}`,
        url: `${state.baseBookUrl}/${generatedId}`,
        num: i
      });
    }

    console.log(`✅ Generated ${chapterLinks.length} chapter URLs from pattern (increment: ${increment})`);

    // Clear learning state and set up for scraping
    userStates[chatId] = {
      novelUrl: state.baseBookUrl,
      chapterLinks,
      novelTitle: state.novelTitle,
      coverUrl: state.coverUrl
    };

    const previewText = `✅ *Pattern Learned\\!*\n\n📖 ${escapeMarkdown(state.novelTitle)}\n📊 Generated *${chapterLinks.length}* chapter URLs\n\nChoose how to proceed:`;

    const keyboard = [
      [{ text: "📚 Scrape All Chapters", callback_data: "scrape_all" }],
      [{ text: "✂️ Choose Range", callback_data: "choose_range" }],
      [{ text: "🔍 Preview First Chapter", callback_data: "preview_first" }]
    ];

    bot.sendMessage(chatId, previewText, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });

    return;
  }

  // Handle range input
  if (userStates[chatId]?.waitingForRange) {
    const match = text.match(/^(\d+)-(\d+)$/);
    if (!match) {
      bot.sendMessage(chatId, "⚠️ Invalid format. Type like `1-100`", { parse_mode: "Markdown" });
      return;
    }

    const start = parseInt(match[1]);
    const end = parseInt(match[2]);
    const { novelUrl, chapterLinks, novelTitle, coverUrl } = userStates[chatId];

    if (start < 1 || end > chapterLinks.length || start > end) {
      bot.sendMessage(chatId, `⚠️ Range must be 1–${chapterLinks.length}`);
      return;
    }

    userStates[chatId].waitingForRange = false;
    const selectedChapters = chapterLinks.slice(start - 1, end);
    bot.sendMessage(chatId, `✅ Selected chapters ${start}-${end}. Starting scrape...`);
    scrapeNovel(chatId, novelUrl, selectedChapters, novelTitle, coverUrl);
    return;
  }

  // Validate URL
  if (!/^https?:\/\//i.test(text)) {
    bot.sendMessage(chatId, "⚠️ **Invalid URL**\n\nPlease send a valid web novel URL starting with `http://` or `https://`\\.\n\n💡 *Example:*\n`https://www\\.webnovel\\.com/book/novel\\-name`", 
      { parse_mode: 'Markdown' });
    return;
  }

  // Helper function to check if URL is actually WebNovel (not freewebnovel.com)
  const isActualWebNovel = (url) => {
    return (url.includes('www.webnovel.com') || url.includes('m.webnovel.com')) && !url.includes('freewebnovel.com');
  };

  // Special handling for WebNovel - try auto-detection first, fallback to manual
  if (isActualWebNovel(text) && text.includes('/book/')) {
    const bookIdMatch = text.match(/book\/(?:[^_\/]+_)?(\d+)/);
    if (bookIdMatch) {
      const bookId = bookIdMatch[1];
      const baseBookUrl = `https://www.webnovel.com/book/${bookId}`;

      // Extract title from URL if possible
      const titleMatch = text.match(/book\/([^_\/]+)_/);
      const novelTitle = titleMatch ? titleMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'WebNovel Book';

      const processingMsg = await bot.sendMessage(chatId, "🔍 Attempting advanced auto-detection...");

      // Strategy 1: Try WebNovel API endpoints first (fastest and most reliable)
      console.log('📡 Strategy 1: Trying WebNovel API endpoints...');
      const apiData = await tryWebNovelAPI(bookId);

      if (apiData) {
        await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
        console.log('✅ WebNovel API succeeded!', apiData);

        // Parse API response and extract chapters
        let chapterLinks = [];
        try {
          // Handle different API response formats
          const chapters = apiData.data?.chapterItems || apiData.data?.volumeItems?.[0]?.chapterItems || apiData.chapters || [];

          if (chapters.length > 0) {
            chapterLinks = chapters.map((ch, idx) => ({
              title: ch.chapterName || ch.name || ch.title || `Chapter ${idx + 1}`,
              url: ch.chapterUrl || `https://www.webnovel.com/book/${bookId}/${ch.chapterId || ch.id}`,
              num: ch.chapterIndex || idx + 1
            }));

            console.log(`✅ Extracted ${chapterLinks.length} chapters from API`);

            // Process as normal
            userStates[chatId] = { 
              novelUrl: text, 
              chapterLinks, 
              novelTitle: apiData.data?.bookName || novelTitle,
              coverUrl: apiData.data?.coverUrl || null 
            };

            const previewText = `📖 *${escapeMarkdown(apiData.data?.bookName || novelTitle)}*\n📊 Found *${chapterLinks.length}* chapters \\(via API\\)\n\nChoose how to proceed:`;

            const keyboard = [
              [{ text: "📚 Scrape All Chapters", callback_data: "scrape_all" }],
              [{ text: "✂️ Choose Range", callback_data: "choose_range" }],
              [{ text: "🔍 Preview First Chapter", callback_data: "preview_first" }]
            ];

            bot.sendMessage(chatId, previewText, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard }
            });

            return; // Success! Exit early
          }
        } catch (parseErr) {
          console.log('⚠️ API response parsing failed:', parseErr.message);
        }
      }

      // Strategy 2: Try to fetch the page with advanced headers
      console.log('🌐 Strategy 2: Trying page fetch with browser headers...');
      try {
        const res = await fetchWithRetry(text, 2);
        await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

        // If we get here, fetch succeeded! Continue with normal WebNovel processing
        console.log('✅ WebNovel page fetch succeeded! Proceeding with extraction...');
        // Fall through to the WebNovel processing below

      } catch (error) {
        // Strategy 3: Try to predict and test chapter URLs
        console.log('🎯 Strategy 3: Predicting chapter URL patterns...');

        const predictedPatterns = [
          // Pattern 1: bookId + small increment (common for first chapter)
          `${baseBookUrl}/${BigInt(bookId) + BigInt(1)}`,
          `${baseBookUrl}/${BigInt(bookId) + BigInt(100)}`,
          `${baseBookUrl}/${BigInt(bookId) + BigInt(1000)}`,
          // Pattern 2: bookId * 2 or similar multipliers
          `${baseBookUrl}/${BigInt(bookId) * BigInt(2)}`,
          `${baseBookUrl}/${BigInt(bookId) * BigInt(3)}`,
          // Pattern 3: Common chapter 1 patterns
          `${baseBookUrl}/1`,
          `${baseBookUrl}/chapter-1`,
          `${baseBookUrl}/chapter_1`,
        ];

        let firstChapterUrl = null;
        let firstChapterId = null;

        for (const testUrl of predictedPatterns) {
          try {
            console.log(`🔍 Testing pattern: ${testUrl}`);
            const testRes = await axios.get(testUrl, {
              headers: getBrowserHeaders(baseBookUrl),
              timeout: 5000,
              maxRedirects: 5,
              validateStatus: (status) => status >= 200 && status < 400
            });

            if (testRes.status === 200) {
              console.log(`✅ Pattern works! Found chapter at: ${testUrl}`);
              firstChapterUrl = testRes.request?.res?.responseUrl || testUrl;

              // Extract chapter ID from the working URL
              const idMatch = firstChapterUrl.match(/[_\/](\d{10,})/);
              if (idMatch) {
                firstChapterId = BigInt(idMatch[1]);
                console.log(`✅ Extracted first chapter ID: ${firstChapterId}`);

                // Try to get total chapters from this page
                const $test = cheerio.load(testRes.data);
                const totalMatch = 
                  testRes.data.match(/Chapter\s+(\d+):/i) ||
                  testRes.data.match(/(\d+)\s*Chs/i) ||
                  testRes.data.match(/(\d+)\s*chapters/i) ||
                  testRes.data.match(/"chapterCount["\s:]+(\d+)/);

                if (totalMatch) {
                  const totalChapters = parseInt(totalMatch[1]);
                  console.log(`✅ Auto-detected ${totalChapters} total chapters!`);

                  await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

                  // Generate all chapter URLs
                  const chapterLinks = [];
                  for (let i = 1; i <= totalChapters; i++) {
                    const chapterId = firstChapterId + BigInt(i - 1);
                    chapterLinks.push({
                      title: `Chapter ${i}`,
                      url: `${baseBookUrl}/${chapterId}`,
                      num: i
                    });
                  }

                  userStates[chatId] = { 
                    novelUrl: text, 
                    chapterLinks, 
                    novelTitle,
                    coverUrl: null 
                  };

                  const previewText = `📖 *${escapeMarkdown(novelTitle)}*\n📊 Auto\\-detected *${totalChapters}* chapters \\(via pattern prediction\\)\\!\n\nChoose how to proceed:`;

                  const keyboard = [
                    [{ text: "📚 Scrape All Chapters", callback_data: "scrape_all" }],
                    [{ text: "✂️ Choose Range", callback_data: "choose_range" }],
                    [{ text: "🔍 Preview First Chapter", callback_data: "preview_first" }]
                  ];

                  bot.sendMessage(chatId, previewText, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: keyboard }
                  });

                  return; // Success! Exit early
                }
                break; // Found working pattern but no total, continue below
              }
            }
          } catch (testErr) {
            console.log(`⚠️ Pattern failed: ${testErr.message}`);
          }
        }

        // Fetch failed (403 or other error) - ask for manual chapter URL
        if (processingMsg) {
          await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
        }

        console.log(`❌ All strategies failed - asking for manual help`);

        userStates[chatId] = {
          learningWebNovel: true,
          bookId: bookId,
          totalChapters: 0,
          novelTitle: novelTitle,
          coverUrl: null,
          baseBookUrl: baseBookUrl
        };

        bot.sendMessage(chatId, `
🔐 **WebNovel Novel Detected**

📖 *${escapeMarkdown(novelTitle)}*

WebNovel has strong anti\\-bot protection\\. I need your quick help\\!

**📲 Simple 3\\-Step Process:**

1️⃣ Open this novel in your browser
2️⃣ Click **any chapter** \\(Ch\\.1, Ch\\.100, latest\\)
3️⃣ Copy \\& send me the chapter URL

**✨ I'll handle the rest automatically:**
✅ Extract chapter pattern
✅ Detect total chapters  
✅ Generate all chapter URLs

💡 *Example chapter URL:*
\`www\\.webnovel\\.com/book/${bookId}/title\\_123...\`

*Ready when you are\\!* 🚀
        `, { parse_mode: 'Markdown' });

        return; // EXIT HERE - don't continue to normal processing
      }
    }
  }

  // For non-WebNovel URLs or when WebNovel handling didn't return early
  let processingMsg = null;
  if (!isActualWebNovel(text)) {
    processingMsg = await bot.sendMessage(chatId, "🔍 Analyzing novel page...");
  }

  try {
    let res;

    // If WebNovel and we got here, we already fetched above
    if (isActualWebNovel(text)) {
      console.log(`📥 Using cached WebNovel fetch result`);
      res = await fetchWithRetry(text, 2); // Re-fetch for WebNovel (already succeeded once)
    } else {
      console.log(`📥 Fetching page: ${text}`);
      res = await fetchWithRetry(text);
    }
    const $ = cheerio.load(res.data);

    let novelTitle =
      $("meta[property='og:title']").attr("content") ||
      $("meta[name='title']").attr("content") ||
      $("h1").first().text().trim() ||
      $("title").text().trim().replace(/\s*-\s*.+$/, '') ||
      "Untitled Novel";

    novelTitle = novelTitle.replace(/^\s*Read\s+|^\s*Novel\s+/i, '').trim();

    let coverUrl =
      $("meta[property='og:image']").attr("content") ||
      $("meta[name='image']").attr("content") ||
      $("img.cover, .novel-cover img, img[alt*='cover']").first().attr("src") ||
      $("img").first().attr("src");

    if (coverUrl && !coverUrl.startsWith('http')) {
      try {
        coverUrl = new URL(coverUrl, text).href;
      } catch (e) {
        coverUrl = null;
      }
    }

    // Special handling for WebNovel - chapters are in JSON data
    let chapterLinks = [];

    if (isActualWebNovel(text)) {
      console.log('🔍 Detected WebNovel - searching for chapter data...');

      // Extract book ID from URL (works for both mobile and PC)
      // Mobile: https://m.webnovel.com/book/lord-of-mysteries_11022733006234505
      // PC: https://www.webnovel.com/book/11022733006234505
      const bookIdMatch = text.match(/book\/(?:[^_\/]+_)?(\d+)/);
      const bookId = bookIdMatch ? bookIdMatch[1] : null;

      // Normalize URL to PC version for chapter construction
      const baseBookUrl = bookId ? `https://www.webnovel.com/book/${bookId}` : text.replace('m.webnovel.com', 'www.webnovel.com');

      console.log(`📚 Book ID: ${bookId}, Base URL: ${baseBookUrl}`);

      // Try to find chapter data in script tags and HTML
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const scriptContent = $(script).html() || '';

        // Multiple JSON extraction strategies
        if (scriptContent.includes('chapterList') || scriptContent.includes('chapters') || scriptContent.includes('chapterId')) {
          try {
            // Strategy 1: Extract chapterList array
            let jsonData = null;

            // Try different JSON patterns
            const patterns = [
              /chapterList["\s:]+(\[[^\]]+\])/,
              /"chapters":\s*(\[[^\]]+\])/,
              /g_data\.book\s*=\s*(\{[^}]+chapterList[^}]+\})/,
              /__NUXT__\s*=\s*([^;]+);/,
            ];

            for (const pattern of patterns) {
              const match = scriptContent.match(pattern);
              if (match) {
                try {
                  jsonData = JSON.parse(match[1]);
                  if (Array.isArray(jsonData) && jsonData.length > 0) {
                    // Found array of chapters
                    chapterLinks = jsonData.map((ch, idx) => {
                      let chapterUrl = ch.chapterUrl || ch.url || ch.href;

                      if (!chapterUrl && (ch.chapterId || ch.id)) {
                        const id = ch.chapterId || ch.id;
                        chapterUrl = `${baseBookUrl}/${id}`;
                      }

                      if (chapterUrl) {
                        chapterUrl = chapterUrl.replace('m.webnovel.com', 'www.webnovel.com');
                        if (!chapterUrl.startsWith('http')) {
                          chapterUrl = `https://www.webnovel.com${chapterUrl.startsWith('/') ? '' : '/'}${chapterUrl}`;
                        }
                      }

                      return {
                        title: ch.chapterName || ch.name || ch.title || `Chapter ${idx + 1}`,
                        url: chapterUrl || `${baseBookUrl}/chapter_${idx + 1}`,
                        num: idx + 1
                      };
                    });
                    console.log(`✅ Found ${chapterLinks.length} chapters from pattern: ${pattern}`);
                    break;
                  } else if (jsonData.chapterList && Array.isArray(jsonData.chapterList)) {
                    // Found object with chapterList
                    chapterLinks = jsonData.chapterList.map((ch, idx) => ({
                      title: ch.chapterName || ch.name || `Chapter ${idx + 1}`,
                      url: (ch.chapterUrl || `${baseBookUrl}/${ch.chapterId}`).replace('m.webnovel.com', 'www.webnovel.com'),
                      num: idx + 1
                    }));
                    console.log(`✅ Found ${chapterLinks.length} chapters from chapterList object`);
                    break;
                  }
                } catch (parseErr) {
                  continue;
                }
              }
            }

            if (chapterLinks.length > 0) break;
          } catch (e) {
            console.log('⚠️ Failed to parse WebNovel JSON:', e.message);
          }
        }
      }

      // Fallback: Try to extract from HTML TOC
      if (chapterLinks.length === 0) {
        console.log('🔍 Trying HTML TOC extraction...');
        const tocLinks = $('a[href*="/book/"]').toArray();
        for (const link of tocLinks) {
          const $link = $(link);
          const href = $link.attr('href');
          const text = $link.text().trim();

          if (href && text && /chapter|ch\.|episode|ep\.|^\d+\s+\w/i.test(text)) {
            const fullUrl = href.startsWith('http') ? href : `https://www.webnovel.com${href}`;
            chapterLinks.push({
              title: text,
              url: fullUrl.replace('m.webnovel.com', 'www.webnovel.com'),
              num: chapterLinks.length + 1
            });
          }
        }

        if (chapterLinks.length > 0) {
          console.log(`✅ Found ${chapterLinks.length} chapters from HTML TOC`);
        }
      }

      // Check if we got all chapters or if some are missing
      // Try multiple patterns to find the true chapter count
      const chapterCountMatch = 
        res.data.match(/Chapter\s+(\d+):/i) ||  // "Chapter 2630:" (latest chapter)
        res.data.match(/Latest Release[^>]*Chapter\s+(\d+)/i) ||  // "Latest Release: Chapter 2630"
        res.data.match(/"chapterCount["\s:]+(\d+)/) ||  // JSON chapterCount
        res.data.match(/(\d+)\s*Chs/i) ||  // "2630 Chs"
        res.data.match(/(\d+)\s+Chapters/i);  // "2630 Chapters"

      if (chapterCountMatch && chapterLinks.length > 0) {
        const totalChapters = parseInt(chapterCountMatch[1]);

        if (totalChapters > chapterLinks.length) {
          const missingCount = totalChapters - chapterLinks.length;
          console.log(`⚠️ WebNovel: Found ${chapterLinks.length}/${totalChapters} chapters (${missingCount} missing - likely premium)`);

          // Try to fill in missing chapters by pattern matching
          if (chapterLinks.length >= 2) {
            // Analyze URL pattern from existing chapters
            const firstUrl = chapterLinks[0].url;
            const secondUrl = chapterLinks[1].url;

            // Check if URLs follow a simple increment pattern
            const firstIdMatch = firstUrl.match(/\/(\d+)$/);
            const secondIdMatch = secondUrl.match(/\/(\d+)$/);

            if (firstIdMatch && secondIdMatch) {
              const firstId = BigInt(firstIdMatch[1]);
              const secondId = BigInt(secondIdMatch[1]);
              const increment = secondId - firstId;

              console.log(`🔍 Detected chapter ID pattern: increment by ${increment}`);

              // Generate missing chapters
              for (let i = chapterLinks.length; i < totalChapters; i++) {
                const chapterId = firstId + (BigInt(i) * increment);
                const baseUrl = firstUrl.substring(0, firstUrl.lastIndexOf('/'));
                const generatedUrl = `${baseUrl}/${chapterId}`.replace('m.webnovel.com', 'www.webnovel.com');
                chapterLinks.push({
                  title: `Chapter ${i + 1}`,
                  url: generatedUrl,
                  num: i + 1
                });
              }

              console.log(`✅ Generated ${missingCount} missing chapter URLs`);
            }
          }
        }
      }

      // Final fallback: If we know chapter count but have no chapters, try desktop version
      if (chapterLinks.length === 0 && chapterCountMatch) {
        const totalChapters = parseInt(chapterCountMatch[1]);
        console.log(`📊 WebNovel has ${totalChapters} chapters but couldn't extract them`);

        // Try fetching desktop version if we were on mobile
        if (isActualWebNovel(text) && text.includes('m.webnovel.com') && bookId) {
          const desktopUrl = `https://www.webnovel.com/book/${bookId}`;
          console.log(`🔄 Trying desktop version: ${desktopUrl}`);

          try {
            const desktopRes = await fetchWithRetry(desktopUrl, 3);
            const $desktop = cheerio.load(desktopRes.data);

            // Try all extraction methods on desktop version
            const desktopScripts = $desktop('script').toArray();
            for (const script of desktopScripts) {
              const scriptContent = $desktop(script).html() || '';
              const patterns = [
                /chapterList["\s:]+(\[[^\]]+\])/,
                /"chapters":\s*(\[[^\]]+\])/,
              ];

              for (const pattern of patterns) {
                const match = scriptContent.match(pattern);
                if (match) {
                  try {
                    const data = JSON.parse(match[1]);
                    if (Array.isArray(data) && data.length > 0) {
                      chapterLinks = data.map((ch, idx) => ({
                        title: ch.chapterName || ch.name || `Chapter ${idx + 1}`,
                        url: (ch.chapterUrl || `${baseBookUrl}/${ch.chapterId || ch.id}`).replace('m.webnovel.com', 'www.webnovel.com'),
                        num: idx + 1
                      }));
                      console.log(`✅ Found ${chapterLinks.length} chapters from desktop version`);
                      break;
                    }
                  } catch (e) {}
                }
              }
              if (chapterLinks.length > 0) break;
            }
          } catch (e) {
            console.log(`⚠️ Desktop version fetch failed: ${e.message}`);
          }
        }

        // Still nothing? Try to auto-detect first chapter URL
        if (chapterLinks.length === 0) {
          console.log('🔍 Attempting to auto-detect first chapter URL...');

          // Look for "Read" or "Start Reading" button
          const readButtons = $('a').toArray();
          let firstChapterUrl = null;

          for (const btn of readButtons) {
            const $btn = $(btn);
            const btnText = $btn.text().trim().toLowerCase();
            const href = $btn.attr('href');

            if (href && (
              btnText.includes('read') || 
              btnText.includes('start') || 
              btnText.includes('chapter 1') ||
              btnText.includes('ch 1') ||
              btnText === '1'
            )) {
              // Check if href contains a chapter ID
              const chIdMatch = href.match(/[_\/](\d{10,})/);
              if (chIdMatch) {
                firstChapterUrl = href.startsWith('http') ? href : `https://www.webnovel.com${href}`;
                console.log(`✅ Found first chapter URL from button: ${firstChapterUrl}`);
                break;
              }
            }
          }

          // If found, use it to generate all chapters
          if (firstChapterUrl) {
            const chIdMatch = firstChapterUrl.match(/[_\/](\d{10,})/);
            if (chIdMatch) {
              const firstChapterId = BigInt(chIdMatch[1]);
              console.log(`✅ Auto-detected first chapter ID: ${firstChapterId}`);

              // Generate all chapter URLs
              for (let i = 1; i <= totalChapters; i++) {
                const chapterId = firstChapterId + BigInt(i - 1);
                chapterLinks.push({
                  title: `Chapter ${i}`,
                  url: `${baseBookUrl}/${chapterId}`,
                  num: i
                });
              }

              console.log(`✅ Auto-generated ${chapterLinks.length} chapter URLs from first chapter`);
            }
          }

          // Still nothing? Use user-assisted pattern learning
          if (chapterLinks.length === 0) {
            // Store the context for pattern learning
            userStates[chatId] = {
              learningWebNovel: true,
              bookId: bookId,
              totalChapters: totalChapters,
              novelTitle: novelTitle,
              coverUrl: coverUrl,
              baseBookUrl: baseBookUrl
            };

            bot.sendMessage(chatId, `
🔐 **WebNovel is blocking automated access**

Novel: *${escapeMarkdown(novelTitle)}*
Chapters: *${totalChapters}*

📝 **Easy Solution:**
1\\. Open this novel in your browser
2\\. Click on ANY chapter \\(chapter 1, 2, or any\\)
3\\. Copy the chapter URL
4\\. Send it to me

I'll learn the URL pattern and generate all ${totalChapters} chapter links automatically\\!

*Example chapter URL:*
\`https://www.webnovel.com/book/123.../456...\`
            `, { parse_mode: 'Markdown' });
            if (processingMsg) {
              await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
            }
            return;
          }
        }
      }
    }

    // Normal chapter detection for other sites
    if (chapterLinks.length === 0) {
      chapterLinks = detectChapterLinks($, text);
    }

    // Smart chapter generation for sites with JavaScript-loaded chapters
    // These sites (novelbin.me, freewebnovel.com) only show 30-40 chapters initially
    const isDynamicSite = text.includes('novelbin.me') || text.includes('freewebnovel.com');
    const suspiciousChapterCount = chapterLinks.length > 0 && chapterLinks.length <= 50;

    if (isDynamicSite && suspiciousChapterCount) {
      console.log(`🔍 Dynamic site detected with ${chapterLinks.length} chapters - looking for metadata...`);

      // Try to extract total chapters from metadata
      let totalChapters = 0;
      let lastChapterNum = 0;

      // Strategy 1: Check meta tags for latest chapter
      const lastChapterMeta = $('meta[property="og:novel:lastest_chapter_url"]').attr('content');
      if (lastChapterMeta) {
        const numMatch = lastChapterMeta.match(/chapter[_-]?(\d+)/i);
        if (numMatch) {
          lastChapterNum = parseInt(numMatch[1]);
          console.log(`✅ Found last chapter from metadata: ${lastChapterNum}`);
        }
      }

      // Strategy 2: Look for "Latest chapter" link in HTML
      if (!lastChapterNum) {
        const latestLinks = $('a.chapter-title, a.latest-chapter, .l-chapter a').toArray();
        for (const link of latestLinks) {
          const href = $(link).attr('href') || '';
          const numMatch = href.match(/chapter[_-]?(\d+)/i);
          if (numMatch) {
            const num = parseInt(numMatch[1]);
            if (num > lastChapterNum) {
              lastChapterNum = num;
            }
          }
        }
        if (lastChapterNum) {
          console.log(`✅ Found last chapter from latest link: ${lastChapterNum}`);
        }
      }

      // Strategy 3: Check for chapter count in page text
      if (!lastChapterNum) {
        const pageText = res.data;
        const countMatches = pageText.match(/(\d+)\s*chapters?/i) || pageText.match(/chapter[s]?\s*[:\-]?\s*(\d+)/i);
        if (countMatches) {
          totalChapters = parseInt(countMatches[1]);
          console.log(`✅ Found chapter count from text: ${totalChapters}`);
        }
      }

      // If we found a last chapter number or total, generate URLs
      if (lastChapterNum > chapterLinks.length || totalChapters > chapterLinks.length) {
        const chaptersToGenerate = lastChapterNum || totalChapters;

        // Extract the URL pattern from first chapter
        if (chapterLinks.length > 0 && chapterLinks[0].url) {
          const firstUrl = chapterLinks[0].url;
          const basePattern = firstUrl.replace(/chapter[_-]?\d+.*$/i, '');

          console.log(`🔧 Generating ${chaptersToGenerate} chapter URLs from pattern: ${basePattern}chapter-N`);

          if (processingMsg) {
            await bot.editMessageText(
              `🔧 **Smart Detection Activated**\n\n📊 Found metadata indicating **${chaptersToGenerate} chapters**\n🔄 Generating full chapter list...`,
              {
                chat_id: chatId,
                message_id: processingMsg.message_id
              }
            ).catch(() => {});
          }

          // Generate all chapter URLs
          const generatedLinks = [];
          for (let i = 1; i <= chaptersToGenerate; i++) {
            generatedLinks.push({
              title: `Chapter ${i}`,
              url: `${basePattern}chapter-${i}`,
              num: i
            });
          }

          console.log(`✅ Generated ${generatedLinks.length} chapter URLs`);
          chapterLinks = generatedLinks;

          if (processingMsg) {
            await bot.editMessageText(
              `✅ **Success!**\n\n📚 Generated **${generatedLinks.length} chapters**\n🎯 Ready to scrape!`,
              {
                chat_id: chatId,
                message_id: processingMsg.message_id
              }
            ).catch(() => {});
            await new Promise(r => setTimeout(r, 1500));
          }
        } else {
          console.log(`⚠️ No chapter links to extract pattern from`);
        }
      } else {
        console.log(`ℹ️ Metadata chapter count (${lastChapterNum || totalChapters}) not greater than detected (${chapterLinks.length})`);
      }
    }

    if (processingMsg) {
      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    }

    if (!chapterLinks.length) {
      bot.sendMessage(chatId, `
❌ **No Chapters Detected**

I couldn't find any chapters on this page\\.

**🤔 Possible reasons:**
• Site uses dynamic loading
• Chapters require login
• Wrong URL \\(need TOC page\\)

**💡 Solution:**
Try sending the **table of contents** or **chapter list** page URL instead\\.
      `, { parse_mode: 'MarkdownV2' });
      return;
    }

    userStates[chatId] = { novelUrl: text, chapterLinks, novelTitle, coverUrl };

    const previewText = `📖 *${escapeMarkdown(novelTitle)}*\n📊 Found *${chapterLinks.length}* chapters\n🔗 [Source](${text})\n\nChoose how to proceed:`;

    const keyboard = [
      [{ text: "📚 Scrape All Chapters", callback_data: "scrape_all" }]
    ];

    if (chapterLinks.length > 10) {
      keyboard.push([{ text: "✂️ Choose Range", callback_data: "choose_range" }]);
    }

    keyboard.push([{ text: "🔍 Preview First Chapter", callback_data: "preview_first" }]);

    const options = {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
      disable_web_page_preview: true
    };

    if (coverUrl) {
      bot.sendPhoto(chatId, coverUrl, { caption: previewText, ...options })
        .catch(() => bot.sendMessage(chatId, previewText, options));
    } else {
      bot.sendMessage(chatId, previewText, options);
    }

  } catch (err) {
    if (processingMsg) {
      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    }
    console.error("❌ Fetch failed:", err.message);

    // Special handling for WebNovel 403 errors
    if (isActualWebNovel(text) && (err.message.includes('403') || err.message.includes('blocked'))) {
      const bookIdMatch = text.match(/book\/(?:[^_\/]+_)?(\d+)/);
      if (bookIdMatch) {
        const bookId = bookIdMatch[1];
        const titleMatch = text.match(/book\/([^_\/]+)_/);
        const novelTitle = titleMatch ? titleMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'WebNovel Book';

        userStates[chatId] = {
          learningWebNovel: true,
          bookId: bookId,
          totalChapters: 0,
          novelTitle: novelTitle,
          coverUrl: null,
          baseBookUrl: `https://www.webnovel.com/book/${bookId}`
        };

        bot.sendMessage(chatId, `
🔐 **WebNovel Novel Detected**

📖 *${escapeMarkdown(novelTitle)}*

WebNovel has strong anti\\-bot protection\\. I need your quick help\\!

**📲 Simple 3\\-Step Process:**

1️⃣ Open this novel in your browser
2️⃣ Click **any chapter** \\(Ch\\.1, Ch\\.100, latest\\)
3️⃣ Copy \\& send me the chapter URL

**✨ I'll handle the rest automatically:**
✅ Extract chapter pattern
✅ Detect total chapters  
✅ Generate all chapter URLs

💡 *Example chapter URL:*
\`www\\.webnovel\\.com/book/${bookId}/title\\_123...\`

*Ready when you are\\!* 🚀
        `, { parse_mode: 'Markdown' });
        return;
      }
    }

    // For other errors, show the error message
    bot.sendMessage(chatId, `❌ Failed to fetch novel page.\n\n**Error:** ${escapeMarkdown(err.message)}\n\nThe site might be blocking requests or is temporarily down.`, 
      { parse_mode: 'Markdown' });
  }
});

// --- Handle buttons ---
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userStates[chatId];
  const library = loadLibrary();
  const books = library[chatId] || [];

  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === "scrape_all" && state) {
    scrapeNovel(chatId, state.novelUrl, state.chapterLinks, state.novelTitle, state.coverUrl);
  }

  if (data === "choose_range" && state) {
    bot.sendMessage(chatId, `✂️ **Choose Chapter Range**\n\nType the range like: \`1-${state.chapterLinks.length}\`\n\n**Examples:**\n• \`1-50\` \\- First 50 chapters\n• \`1-${Math.min(10, state.chapterLinks.length)}\` \\- For testing`, 
      { parse_mode: 'Markdown' });
    userStates[chatId].waitingForRange = true;
  }

  if (data === "preview_first" && state) {
    const firstCh = state.chapterLinks[0];
    try {
      const res = await fetchWithRetry(firstCh.url);
      const $ = cheerio.load(res.data);
      const content = extractChapterContent($);
      const preview = content.replace(/<[^>]+>/g, '').substring(0, 500);
      bot.sendMessage(chatId, `📄 **Preview: ${escapeMarkdown(firstCh.title)}**\n\n${escapeMarkdown(preview)}...\n\n✅ Content looks good? Use the buttons above to scrape.`, 
        { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to preview: ${escapeMarkdown(err.message)}`);
    }
  }

  if (data === "cancel") {
    if (userStates[chatId]) {
      userStates[chatId].cancel = true;
      bot.sendMessage(chatId, "⏸️ Cancellation requested...");
    }
  }

  if (data.startsWith("download_")) {
    const index = parseInt(data.replace("download_", ""));
    const book = books[index];
    if (!book) return bot.sendMessage(chatId, "⚠️ Book not found in library.");

    const safeTitle = sanitizeFilename(book.title);
    const filePath = path.join(EPUB_DIR, `${safeTitle}.epub`);

    if (fs.existsSync(filePath)) {
      bot.sendMessage(chatId, `📤 Sending *${escapeMarkdown(book.title)}*...`, { parse_mode: 'Markdown' });
      await bot.sendDocument(chatId, filePath);
    } else {
      bot.sendMessage(chatId, "⚠️ EPUB file not found. Please rescrape the novel.");
    }
  }

  if (data.startsWith("delete_")) {
    const index = parseInt(data.replace("delete_", ""));
    const book = books[index];
    if (!book) return bot.sendMessage(chatId, "⚠️ Book not found.");

    library[chatId].splice(index, 1);
    if (library[chatId].length === 0) delete library[chatId];
    await saveLibrary(library);

    const safeTitle = sanitizeFilename(book.title);
    const filePath = path.join(EPUB_DIR, `${safeTitle}.epub`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    bot.sendMessage(chatId, `🗑 Deleted *${escapeMarkdown(book.title)}* from library.`, { parse_mode: "Markdown" });
  }

  if (data.startsWith("update_")) {
    const index = parseInt(data.replace("update_", ""));
    const book = books[index];
    if (!book) return bot.sendMessage(chatId, "⚠️ Book not found.");

    try {
      const res = await fetchWithRetry(book.url);
      const $ = cheerio.load(res.data);
      const chapterLinks = detectChapterLinks($, book.url);

      if (chapterLinks.length > book.chapters) {
        const newChapters = chapterLinks.slice(book.chapters);
        bot.sendMessage(
          chatId,
          `🔄 Found *${newChapters.length}* new chapters for *${escapeMarkdown(book.title)}*!\n\nStarting update...`,
          { parse_mode: 'Markdown' }
        );
        scrapeNovel(chatId, book.url, chapterLinks, book.title, book.coverUrl);
      } else {
        bot.sendMessage(chatId, `✅ *${escapeMarkdown(book.title)}* is already up to date.`, {
          parse_mode: "Markdown",
        });
      }
    } catch (err) {
      console.error("Update failed:", err.message);
      bot.sendMessage(chatId, `❌ Failed to update: ${escapeMarkdown(err.message)}`);
    }
  }
});

// --- Alternative content extractors ---
function extractByBruteForce($) {
  // Remove noise
  $("script, style, iframe, noscript, form, header, footer, nav, aside, .ad, .ads").remove();

  // Get all text from body
  const bodyText = $("body").text();
  const lines = bodyText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 30)
    .filter(line => !/^(previous|next|chapter|menu|home)/i.test(line))
    .filter(line => !/advertisement|subscribe|login/i.test(line));

  if (lines.length < 5) return null;

  return lines
    .map(line => `<p style="margin:0 0 1em 0;">${line}</p>`)
    .join("");
}

function extractByParagraphDensity($) {
  $("script, style, iframe, noscript").remove();

  let bestElement = null;
  let maxScore = 0;

  $("div, article, section, main").each((i, elem) => {
    const $elem = $(elem);
    const paragraphs = $elem.find("p").length;
    const textLength = $elem.text().trim().length;
    const score = paragraphs * textLength;

    if (score > maxScore && textLength > 500) {
      maxScore = score;
      bestElement = elem;
    }
  });

  if (!bestElement) return null;

  const paragraphs = $(bestElement)
    .find("p")
    .map((i, el) => $(el).text().trim())
    .get()
    .filter(p => p.length > 20)
    .map(p => `<p style="margin:0 0 1em 0;">${p}</p>`);

  return paragraphs.join("");
}

// --- Enhanced chapter fetcher with multiple strategies ---
async function fetchChapter(chapterUrl, chapterTitle, retries = 8) {
  const strategies = [
    { name: "Standard", fn: extractChapterContent },
    { name: "Paragraph Density", fn: extractByParagraphDensity },
    { name: "Brute Force", fn: extractByBruteForce }
  ];

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Exponential backoff delay BEFORE fetching (except first attempt)
      if (attempt > 1) {
        const delay = Math.min(1000 * Math.pow(1.5, attempt - 1), 10000);
        await new Promise(r => setTimeout(r, delay));
      }

      // Fetch with retries
      const res = await fetchWithRetry(chapterUrl, 3);
      const $ = cheerio.load(res.data);

      // Try each extraction strategy
      for (const strategy of strategies) {
        try {
          const text = strategy.fn($);

          if (!text || text.length < 200) continue;
          if (text.includes('No readable content')) continue;

          // Success!
          console.log(`✅ ${chapterTitle} - Strategy: ${strategy.name}, Attempt: ${attempt}`);
          return {
            success: true,
            title: chapterTitle,
            data: `<h2 style="text-align:center;margin:1em 0;">${chapterTitle}</h2>${text}`,
          };
        } catch (stratErr) {
          console.log(`⚠️ Strategy ${strategy.name} failed for ${chapterTitle}`);
          continue;
        }
      }

      // If all strategies failed, continue to next attempt
      console.log(`⚠️ All strategies failed for ${chapterTitle}, attempt ${attempt}/${retries}`);

    } catch (err) {
      console.error(`❌ Fetch error for ${chapterTitle} (attempt ${attempt}/${retries}): ${err.message}`);
    }
  }

  // Ultimate fallback - return placeholder
  console.error(`❌❌ FAILED: ${chapterTitle} after ${retries} attempts with all strategies`);
  return {
    success: false,
    title: chapterTitle,
    url: chapterUrl,
    data: `<h2 style="text-align:center;margin:1em 0;">${chapterTitle}</h2><p style="color:#ff6b6b;text-align:center;font-style:italic;">⚠️ This chapter could not be loaded after ${retries} attempts using multiple methods. The chapter may be:\n\n• Behind a paywall or login\n• Protected by anti-scraping technology\n• Temporarily unavailable\n\nChapter URL: ${chapterUrl}</p>`,
  };
}

// --- Scrape & Generate EPUB ---
async function scrapeNovel(chatId, url, selectedChapters, novelTitle, coverUrl) {
  userStates[chatId] = userStates[chatId] || {};
  userStates[chatId].cancel = false;

  let progressMsg = await bot.sendMessage(chatId, `🚀 **Starting Download**\n\n📚 Scraping ${selectedChapters.length} chapters\\.\\.\\.\n⏱️ This will take a few minutes\n\n*Tip: You can cancel anytime\\!*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel" }]] },
  });

  const content = [];
  const failedChapters = [];
  const total = selectedChapters.length;
  const startTime = Date.now();
  const batchSize = 8;

  for (let i = 0; i < total; i += batchSize) {
    if (userStates[chatId]?.cancel) {
      await bot.editMessageText("❌ Scraping cancelled.", {
        chat_id: chatId,
        message_id: progressMsg.message_id,
      }).catch(() => {});
      return;
    }

    const batch = selectedChapters.slice(i, i + batchSize);

    const results = await Promise.all(
      batch.map(async (ch, idx) => {
        const chapterNum = i + idx + 1;
        const result = await fetchChapter(ch.url, ch.title);

        if (!result.success) {
          failedChapters.push({
            num: chapterNum,
            title: ch.title,
            url: ch.url
          });
        }

        return result;
      })
    );

    content.push(...results);

    const done = Math.min(i + batch.length, total);
    const elapsed = Date.now() - startTime;
    const avgPerChapter = elapsed / done;
    const remaining = avgPerChapter * (total - done);

    const failedCount = failedChapters.length;
    const statusText = failedCount > 0 
      ? `📖 *Scraping ${escapeMarkdown(novelTitle)}*\n\n${buildProgress(done, total)}\n${formatETA(remaining)}\n\n⚠️ ${failedCount} failed`
      : `📖 *Scraping ${escapeMarkdown(novelTitle)}*\n\n${buildProgress(done, total)}\n${formatETA(remaining)}`;

    await bot.editMessageText(statusText, {
      chat_id: chatId,
      message_id: progressMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel" }]] },
    }).catch(() => {});
  }

  if (userStates[chatId]?.cancel) {
    return;
  }

  // Second pass: Retry failed chapters with more aggressive settings
  if (failedChapters.length > 0 && failedChapters.length <= 50) {
    await bot.editMessageText(
      `🔄 *Second Pass: Retrying ${failedChapters.length} failed chapters...*\n\nUsing more aggressive retry strategies...`,
      {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: 'Markdown'
      }
    ).catch(() => {});

    console.log(`🔄 Starting second pass for ${failedChapters.length} failed chapters`);

    const retryResults = await Promise.all(
      failedChapters.map(async (failed) => {
        // Wait longer before retrying
        await new Promise(r => setTimeout(r, Math.random() * 3000 + 2000));

        console.log(`🔄 Retrying: ${failed.title}`);
        const result = await fetchChapter(failed.url, failed.title, 10); // 10 retries for second pass

        return {
          originalIndex: failed.num - 1,
          result
        };
      })
    );

    // Replace failed chapters with retry results
    let recoveredCount = 0;
    retryResults.forEach(({ originalIndex, result }) => {
      if (result.success) {
        content[originalIndex] = result;
        recoveredCount++;
        console.log(`✅ Recovered: ${result.title}`);
      } else {
        content[originalIndex] = result; // Keep the updated failure message
      }
    });

    // Update failed chapters list
    const stillFailed = failedChapters.filter((_, idx) => !retryResults[idx].result.success);
    failedChapters.length = 0;
    failedChapters.push(...stillFailed);

    if (recoveredCount > 0) {
      await bot.editMessageText(
        `✅ *Second pass complete!*\n\n🔄 Recovered *${recoveredCount}* chapters\n⚠️ Still failed: ${failedChapters.length}`,
        {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          parse_mode: 'Markdown'
        }
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await bot.editMessageText(`📦 **Creating Your EPUB**\n\n✨ Compiling *${escapeMarkdown(novelTitle)}* into a beautiful ebook\\.\\.\\.\n⏳ Almost done\\!`, {
    chat_id: chatId,
    message_id: progressMsg.message_id,
    parse_mode: 'Markdown'
  }).catch(() => {});

  let coverPath = null;
  try {
    if (coverUrl) {
      const img = await axios.get(coverUrl, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
          Referer: url,
        },
        timeout: 10000,
      });
      coverPath = path.join(__dirname, `cover_${Date.now()}.jpg`);
      fs.writeFileSync(coverPath, img.data);
    }
  } catch (err) {
    console.error("⚠️ Cover download failed:", err.message);
  }

  const safeTitle = sanitizeFilename(novelTitle);
  const filePath = path.join(EPUB_DIR, `${safeTitle}.epub`);

  const epubOptions = {
    title: novelTitle,
    author: "WebToEpub Bot",
    cover: coverPath || undefined,
    content,
    css: `
      body { font-family: Georgia, serif; line-height: 1.6; padding: 1em; }
      h2 { page-break-before: always; }
      p { text-align: justify; margin: 0 0 1em 0; }
    `,
  };

  try {
    await new Epub(epubOptions, filePath).promise;
    console.log(`✅ EPUB created: ${filePath}`);
  } catch (err) {
    console.error("❌ EPUB generation failed:", err.message);
    await bot.editMessageText(`❌ Failed to create EPUB: ${escapeMarkdown(err.message)}`, {
      chat_id: chatId,
      message_id: progressMsg.message_id,
    }).catch(() => {});
    if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    return;
  }

  const successCount = total - failedChapters.length;
  const timeElapsed = Math.round((Date.now() - startTime) / 1000);

  let completionMsg = `✅ **Download Complete\\!**\n\n`;
  completionMsg += `📖 *${escapeMarkdown(novelTitle)}*\n`;
  completionMsg += `📊 **${successCount}** out of **${total}** chapters\n`;
  completionMsg += `⏱️ Completed in ${timeElapsed}s\n\n`;

  if (failedChapters.length > 0) {
    completionMsg += `⚠️ *${failedChapters.length} chapters couldn't be downloaded*\n`;
    completionMsg += `They're marked in the EPUB file\\.`;
  } else {
    completionMsg += `🎉 Perfect\\! All chapters downloaded successfully\\!`;
  }

  await bot.editMessageText(completionMsg, {
    chat_id: chatId,
    message_id: progressMsg.message_id,
    parse_mode: "MarkdownV2",
  }).catch(() => {});

  await bot.sendDocument(chatId, filePath, {
    caption: `📖 *${escapeMarkdown(novelTitle)}*\n📊 ${total} chapters${failedChapters.length > 0 ? ` (${failedChapters.length} failed)` : ''}`,
    parse_mode: 'Markdown'
  }).catch((err) => {
    console.error("❌ Send document failed:", err.message);
    bot.sendMessage(chatId, `❌ Failed to send EPUB file. File may be too large.`);
  });

  // Send detailed failed chapters list if any
  if (failedChapters.length > 0) {
    const failedList = failedChapters
      .slice(0, 20)
      .map(ch => `• Ch ${ch.num}: ${ch.title}`)
      .join('\n');

    let failedMsg = `⚠️ **Chapters That Couldn't Be Downloaded (${failedChapters.length}):**\n\n${failedList}`;
    if (failedChapters.length > 20) {
      failedMsg += `\n\n...and ${failedChapters.length - 20} more`;
    }
    failedMsg += `\n\n**🤔 Why did this happen?**\n• Chapters behind paywall\n• Anti\\-bot protection\n• Temporarily unavailable\n\n**💡 What you can try:**\nScrape them from a different source or website\\.`;

    bot.sendMessage(chatId, failedMsg, { parse_mode: 'Markdown' });
  }

  const library = loadLibrary();
  if (!library[chatId]) library[chatId] = [];

  const idx = library[chatId].findIndex((b) => b.title === novelTitle);
  if (idx === -1) {
    library[chatId].push({ title: novelTitle, chapters: total, url, coverUrl });
  } else {
    library[chatId][idx].chapters = total;
  }
  await saveLibrary(library);

  if (coverPath && fs.existsSync(coverPath)) {
    fs.unlink(coverPath, () => {});
  }

  delete userStates[chatId];
}
