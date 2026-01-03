const axios = require("axios");
const cheerio = require("cheerio");

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
};

const delay = ms => new Promise(r => setTimeout(r, ms));

async function scrapeChapterWithRetry(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const chapter = await scrapeChapter(url);
      if (chapter.content && chapter.content.length > 150 && !chapter.content.includes("[Content unavailable")) return chapter;
      if (attempt < maxRetries) await delay(Math.random() * 2000 + (attempt * 1000));
    } catch (err) {
      if (attempt < maxRetries) await delay(Math.random() * 2000 + (attempt * 1000));
    }
  }
  return { title: "Chapter", content: "<p>[Content unavailable after retries]</p>" };
}

async function scrapeChapter(url) {
  try {
    const { data } = await axios.get(url, { headers, timeout: 10000 });
    const $ = cheerio.load(data);
    const title = $("h1").first().text().trim() || $(".chapter-title").text().trim() || "Chapter";
    let content = "";
    const contentSelectors = [
      "article", ".chapter-content", "#chapter-content", ".content",
      ".post-content", ".story-content", ".text-content", "main",
      "[role='main']", "[class*='content']"
    ];
    for (const selector of contentSelectors) {
      const extracted = $(selector).html();
      if (extracted && extracted.length > 100) {
        content = extracted;
        break;
      }
    }
    if (!content || content.length < 50) {
      const paragraphs = [];
      $("p").each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 20) paragraphs.push(`<p>${text}</p>`);
      });
      if (paragraphs.length > 0) content = paragraphs.join("");
    }
    return { title, content };
  } catch (err) {
    return { title: "Chapter", content: "<p>Content unavailable</p>" };
  }
}

async function scrapeNovel(novelUrl, limit = 25, onProgress = null) {
  try {
    const { data } = await axios.get(novelUrl, { headers, timeout: 10000 });
    const $ = cheerio.load(data);
    const novelTitle = $("h1").first().text().trim() || "Unknown";
    
    const chapterLinks = [];
    $("a[href*='chapter'], a[href*='/chapter/']").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().toLowerCase();
      if (href && text.includes("chapter")) {
        try {
          const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
          if (!chapterLinks.includes(url)) chapterLinks.push(url);
        } catch (e) {}
      }
    });

    const chaptersToScrape = chapterLinks.slice(0, limit);
    const chapters = [];
    for (const link of chaptersToScrape) {
      chapters.push(await scrapeChapter(link));
      await delay(Math.random() * 1500 + 500);
    }
    return { novelTitle, chapters };
  } catch (err) {
    throw new Error(`Failed: ${err.message}`);
  }
}

module.exports = { scrapeNovel };
