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
      if (chapter.content && chapter.content.length > 150 && 
          !chapter.content.includes("[Content unavailable")) {
        return chapter;
      }
      if (attempt < maxRetries) {
        await delay(Math.random() * 2000 + (attempt * 1000));
      }
    } catch (err) {
      if (attempt < maxRetries) {
        await delay(Math.random() * 2000 + (attempt * 1000));
      }
    }
  }
  return { title: "Chapter", content: "<p>[Content unavailable after retries]</p>" };
}

async function scrapeChapter(url) {
  try {
    const { data } = await axios.get(url, { headers, timeout: 10000, validateStatus: () => true });
    const $ = cheerio.load(data);
    const title = $("h1").first().text().trim() || "Chapter";
    let content = $(".chapter-content").html() || $("[class*='content']").html() || "";
    if (!content || content.length < 50) content = "<p>[Content unavailable]</p>";
    return { title, content };
  } catch (err) {
    return { title: "Chapter", content: "<p>[Content unavailable]</p>" };
  }
}

async function scrapeNovel(novelUrl, limit = 25, onProgress = null) {
  try {
    const { data } = await axios.get(novelUrl, { headers, timeout: 10000, validateStatus: () => true });
    const $ = cheerio.load(data);
    const novelTitle = $("h1").first().text().trim() || "Unknown Novel";

    const chapterLinks = [];
    $("a[href*='chapter']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        try {
          const url = href.startsWith("http") ? href : `https://www.webnovel.com${href}`;
          if (!chapterLinks.includes(url)) chapterLinks.push(url);
        } catch (e) {}
      }
    });

    const chaptersToScrape = chapterLinks.slice(0, limit);
    if (onProgress) onProgress(0, chaptersToScrape.length);

    const chapters = [];
    for (let i = 0; i < chaptersToScrape.length; i++) {
      chapters.push(await scrapeChapterWithRetry(chaptersToScrape[i], 3));
      if (onProgress) onProgress(i + 1, chaptersToScrape.length);
      await delay(Math.random() * 2000 + 1000);
    }
    return { novelTitle, chapters };
  } catch (err) {
    throw new Error(`Failed: ${err.message}`);
  }
}

module.exports = { scrapeNovel };
