const axios = require("axios");
const cheerio = require("cheerio");

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "DNT": "1",
  "Connection": "keep-alive"
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
        const waitTime = Math.random() * 2000 + (attempt * 1000);
        await delay(waitTime);
      }
    } catch (err) {
      if (attempt < maxRetries) {
        const waitTime = Math.random() * 2000 + (attempt * 1000);
        await delay(waitTime);
      }
    }
  }
  return { title: "Chapter", content: "<p>[Content unavailable after retries]</p>" };
}

async function scrapeChapter(url) {
  try {
    const { data } = await axios.get(url, { 
      headers,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true
    });
    const $ = cheerio.load(data);

    let title = $("h1").first().text().trim() ||
                $("[class*='title']").first().text().trim() ||
                "Chapter";

    let content = "";
    
    // Try multiple content selectors
    const contentSelectors = [
      "article",
      ".chapter-content",
      "#chapter-content",
      ".content",
      ".post-content",
      ".story-content",
      ".text-content",
      "main",
      "[role='main']",
      ".article-content",
      ".entry-content",
      "[class*='content']"
    ];

    for (const selector of contentSelectors) {
      const extracted = $(selector).html();
      if (extracted && extracted.length > 100) {
        content = extracted;
        break;
      }
    }

    // Fallback: extract paragraphs
    if (!content || content.length < 50) {
      const paragraphs = [];
      $("p").each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.length > 20) {
          paragraphs.push(`<p>${text}</p>`);
        }
      });
      if (paragraphs.length > 0) {
        content = paragraphs.join("");
      }
    }

    content = content.replace(/<script[^>]*>.*?<\/script>/gi, "")
                    .replace(/<style[^>]*>.*?<\/style>/gi, "");

    // Remove common navigation text
    content = content.replace(/Use arrow keys \(or A \/ D\) to PREV\/NEXT chapter/gi, "")
                    .replace(/Use arrow keys.*?chapter/gi, "")
                    .replace(/←.*?→/g, "")
                    .replace(/Previous Chapter.*?Next Chapter/gi, "");

    // Clean up extra whitespace from removed content
    content = content.replace(/<p>\s*<\/p>/g, "").replace(/\n{3,}/g, "\n\n");

    if (!content || content.length < 50) {
      content = "<p>[Chapter content not available]</p>";
    }

    return { title: title || "Chapter", content };
  } catch (err) {
    return { title: "Chapter", content: "<p>[Content unavailable]</p>" };
  }
}

async function scrapeNovel(novelUrl, limit = 25, onProgress = null) {
  try {
    const { data } = await axios.get(novelUrl, { 
      headers,
      timeout: 10000,
      validateStatus: () => true
    });
    const $ = cheerio.load(data);

    const novelTitle = $("h1").first().text().trim() ||
                       $("title").text().split("|")[0].trim() ||
                       "Unknown Novel";

    const chapterLinks = [];
    
    const selectors = [
      "a[href*='/chapter']",
      "a[href*='/part']",
      "a[href*='/episode']",
      "a.chapter",
      "a.chapter-link",
      "li a"
    ];

    for (const selector of selectors) {
      $(selector).each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().toLowerCase();
        
        if (href && (text.includes("chapter") || text.includes("part") || text.match(/\d+/))) {
          try {
            const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
            if (!chapterLinks.includes(url) && url !== novelUrl) {
              chapterLinks.push(url);
            }
          } catch (e) {}
        }
      });
      if (chapterLinks.length > 5) break;
    }

    const uniqueLinks = [...new Set(chapterLinks)];
    const chaptersToScrape = uniqueLinks.slice(0, limit);
    
    if (onProgress) onProgress(0, chaptersToScrape.length);

    const chapters = [];
    for (let i = 0; i < chaptersToScrape.length; i++) {
      chapters.push(await scrapeChapterWithRetry(chaptersToScrape[i], 3));
      if (onProgress) onProgress(i + 1, chaptersToScrape.length);
      await delay(Math.random() * 1500 + 500);
    }

    return { novelTitle, chapters };
  } catch (err) {
    throw new Error(`Failed to scrape website: ${err.message}`);
  }
}

module.exports = { scrapeNovel };
