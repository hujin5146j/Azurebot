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

    const title = $(".chapter-title").text().trim() ||
                  $("h1.chapter-title2").text().trim() ||
                  $("h1").first().text().trim() ||
                  "Chapter";

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
                  $("div.cha-words").html() ||
                  $("article").html() || "";

    // Clean ads and unwanted content
    content = content.replace(/<div[^>]*ad[^>]*>.*?<\/div>/gi, "")
                    .replace(/<script[^>]*>.*?<\/script>/gi, "");

    return { title: title || "Chapter", content };
  } catch (err) {
    console.error(`Error scraping chapter ${url}:`, err.message);
    return { title: "Chapter", content: "<p>Failed to scrape chapter</p>" };
  }
}

async function scrapeNovel(novelUrl, limit = 25, onProgress = null) {
  try {
    const { data } = await axios.get(novelUrl, { headers, timeout: 10000 });
    const $ = cheerio.load(data);

    const novelTitle = $(".book-name h1").text().trim() ||
                       $("h1").first().text().trim() ||
                       "Unknown Novel";

    const chapterLinks = [];
    $("a[href*='/chapter/'], a.ch-link").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const fullUrl = href.startsWith("http") ? href : new URL(href, novelUrl).href;
        if (!chapterLinks.includes(fullUrl)) {
          chapterLinks.push(fullUrl);
        }
      }
    });

    const chaptersToScrape = chapterLinks.slice(0, limit);
    console.log(`Found ${chapterLinks.length} chapters, scraping ${chaptersToScrape.length}`);

    const chapters = [];
    for (const link of chaptersToScrape) {
      chapters.push(await scrapeChapter(link));
      await delay(1200);
    }

    return { novelTitle, chapters };
  } catch (err) {
    throw new Error(`Failed to scrape Wuxiaworld: ${err.message}`);
  }
}

module.exports = { scrapeNovel };
