const axios = require("axios");
const cheerio = require("cheerio");

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://freewebnovel.com/",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "f, deflate, br",
  "DNT": "1",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1"
};

const delay = ms => new Promise(r => setTimeout(r, ms));

async function scrapeChapterWithRetry(url, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const chapter = await scrapeChapter(url);
      
      // Check if we got meaningful content
      if (chapter.content && chapter.content.length > 150 && 
          !chapter.content.includes("[Content unavailable")) {
        return chapter;
      }
      
      // If content is too short, it likely failed - retry
      if (attempt < maxRetries) {
        const waitTime = Math.random() * 2000 + (attempt * 1000); // Exponential backoff
        await delay(waitTime);
        continue;
      }
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const waitTime = Math.random() * 2000 + (attempt * 1000);
        await delay(waitTime);
        continue;
      }
    }
  }
  
  // Return fallback after all retries exhausted
  return { title: "Chapter", content: "<p>[Content unavailable after retries]</p>" };
}

async function scrapeChapter(url) {
  try {
    let html = "";
    try {
      const { data } = await axios.get(url, { 
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": url, // Dynamically use the current URL as referer
        },
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true
      });
      html = data;
    } catch (e) {
      console.log(`Axios failed for chapter ${url}, trying playwright...`);
    }

    if (!html || html.includes("Cloudflare") || html.includes("DDoS") || html.length < 5000) {
      try {
        const { chromium } = require("playwright");
        const browser = await chromium.launch({ 
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "commit", timeout: 60000 });
        await page.waitForTimeout(8000);
        
        html = await page.content();
        await browser.close();
      } catch (pwErr) {
        console.error("Playwright chapter scrape failed:", pwErr.message);
      }
    }

    if (!html) return { title: "Chapter", content: "<p>[Content unavailable - load failed]</p>" };

    const $ = cheerio.load(html);

    const title = $(".chapter-title").text().trim() || 
                  $("h1.chapter-title").text().trim() ||
                  $("h1").first().text().trim() ||
                  "Chapter";

    let content = "";
    
    // Try multiple selector patterns for content
    const contentSelectors = [
      "#chapter-content",
      ".chapter-content",
      ".chapter-body",
      ".chr-c",
      ".cha-words",
      "[class*='chapter'][class*='content']",
      ".content",
      "div.text",
      ".text-content",
      "article"
    ];

    for (const selector of contentSelectors) {
      const extracted = $(selector).html();
      if (extracted && extracted.length > 100) {
        content = extracted;
        break;
      }
    }

    // Fallback: extract all paragraphs if no content found
    if (!content || content.length < 100) {
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

    if (!content || content.length < 100) {
      content = "<p>[Chapter content not available - content extraction failed]</p>";
    }

    // Clean up content
    content = content.replace(/<script[^>]*>.*?<\/script>/gi, "")
                    .replace(/<style[^>]*>.*?<\/style>/gi, "")
                    .replace(/<nav[^>]*>.*?<\/nav>/gi, "")
                    .replace(/<footer[^>]*>.*?<\/footer>/gi, "")
                    .replace(/<header[^>]*>.*?<\/header>/gi, "")
                    .replace(/<button[^>]*>.*?<\/button>/gi, "");

    // Remove common navigation text
    content = content.replace(/Use arrow keys \(or A \/ D\) to PREV\/NEXT chapter/gi, "")
                    .replace(/Use arrow keys.*?chapter/gi, "")
                    .replace(/←.*?→/g, "")
                    .replace(/Previous Chapter.*?Next Chapter/gi, "");

    // Clean up extra whitespace from removed content
    content = content.replace(/<p>\s*<\/p>/g, "").replace(/\n{3,}/g, "\n\n");

    if (!content || content.length < 50) {
      content = "<p>[Chapter content not available - content extraction failed]</p>";
    }

    return { title: title || "Chapter", content };
  } catch (err) {
    console.error(`Error scraping chapter:`, err.message);
    return { title: "Chapter", content: "<p>[Content unavailable - request failed]</p>" };
  }
}

async function scrapeChaptersLogic($, novelUrl, limit, onProgress) {
    // If we're on a page that might have a "Latest Chapters" vs "All Chapters" tab
    // FreeWebNovel sometimes requires visiting the /info/ or /chapters/ subpage
    let chapterLinks = [];
    
    // PC FIX: Better slug detection for FreeWebNovel
    const getSlug = (url) => {
      const match = url.match(/\/novel\/([^\/\.]+)/) || url.match(/\/([^\/\.]+)\.html/);
      return match ? match[1] : null;
    };

    const extractLinks = (container) => {
      $(container).find("a").each((_, el) => {
        let href = $(el).attr("href");
        if (href) {
          if (!href.startsWith("http") && !href.startsWith("/")) {
            href = "/" + href;
          }
          try {
            const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
            const linkSlug = getSlug(url);
            const mainSlug = getSlug(novelUrl);
            
            // On PC, links often don't contain 'freewebnovel.com' in the hostname during scraping
            if (url.includes("chapter") && linkSlug === mainSlug) {
              if (!chapterLinks.includes(url)) chapterLinks.push(url);
            }
          } catch (e) {}
        }
      });
    };

    // Strategy 1.0: Visit /info/ or /chapters/ subpage if available
    const slug = getSlug(novelUrl);
    if (slug) {
         const subpages = [
            `https://freewebnovel.com/novel/${slug}/`,
            `https://freewebnovel.com/novel/${slug}.html`,
            `https://freewebnovel.com/novel-chapters/${slug}.html`,
            `https://freewebnovel.com/chapters/${slug}.html`,
            `https://freewebnovel.com/novel/${slug}/chapter-1.html`
         ];
         for (const sub of subpages) {
            if (chapterLinks.length > 50) break;
            try {
               const res = await axios.get(sub, { 
                 headers: { ...headers, "Referer": novelUrl }, 
                 timeout: 8000,
                 validateStatus: () => true
               });
               if (res.status === 200 && res.data) {
                 const $sub = cheerio.load(res.data);
                 $sub("a").each((_, el) => {
                    let href = $sub(el).attr("href");
                    if (href && href.includes("chapter")) {
                       const url = href.startsWith("http") ? href : new URL(href, sub).href;
                       if (!chapterLinks.includes(url)) chapterLinks.push(url);
                    }
                 });
               }
            } catch(e) {}
         }
    }

    // Strategy 1: Look for specific FreeWebNovel selectors
    const selectors = [
      ".chapter-list", 
      ".m-newest2", 
      ".ul-list5", 
      ".list-chapter",
      ".novel-detail-chapters",
      "#chapterlist",
      ".content-list",
      ".chapters",
      ".list-chapter",
      "div.novel-chapters",
      ".ul-list",
      ".chapter-list a",
      "ul.list-chapter li a",
      "div.m-chapter-list",
      ".novel-chapters a",
      "#accordion .card-body a",
      ".m-newest2 a",
      ".ul-list5 a"
    ];
    
    selectors.forEach(sel => extractLinks(sel));

    // Strategy 1.1: Look for FreeWebNovel specific "Show All Chapters" pattern
    if (chapterLinks.length < 5) {
       $("a").each((_, el) => {
         const text = $(el).text().toLowerCase();
         if (text.includes("all chapters") || text.includes("chapter list")) {
            const href = $(el).attr("href");
            if (href && !href.startsWith("#")) {
               // This is likely a link to the full chapter list page
               const fullListUrl = href.startsWith("http") ? href : new URL(href, novelUrl).href;
               chapterLinks.push({ isFullListPage: true, url: fullListUrl });
            }
         }
       });
    }

    // Strategy 1.2: Check for specific hidden chapter container (often used on FreeWebNovel)
    if (chapterLinks.length === 0) {
      const hiddenList = $("#chapterlist, #chapters, .chapter-list-all");
      if (hiddenList.length > 0) {
        hiddenList.find("a").each((_, el) => {
          let href = $(el).attr("href");
          if (href && (href.includes("/chapter-") || href.includes("chapter-"))) {
            const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
            if (!chapterLinks.includes(url)) chapterLinks.push(url);
          }
        });
      }
    }

    // Strategy 1.5: Direct link search for FreeWebNovel on PC
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().toLowerCase();
      // PC FIX: Relax hostname check
      if (href && (
          href.includes("/chapter-") || 
          href.includes("-chapter-") || 
          href.match(/chapter-\d+/) ||
          text.includes("chapter")
      )) {
        try {
          const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
          if (!chapterLinks.includes(url)) {
            chapterLinks.push(url);
          }
        } catch(e) {}
      }
    });

    // Strategy 1.6: Check for chapter links inside 'ul' or 'li' elements with common class names
    if (chapterLinks.length === 0) {
      $("ul li a, div a").each((_, el) => {
        const href = $(el).attr("href");
        if (href && (href.includes(".html") || href.match(/\d+$/))) {
          const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
          if (!chapterLinks.includes(url) && url.includes("freewebnovel.com")) {
             chapterLinks.push(url);
          }
        }
      });
    }

    // Strategy 1.7: Deep search for chapter patterns in text
    if (chapterLinks.length < 5) {
      $("li, div, span").each((_, el) => {
        const text = $(el).text().trim();
        if (/^chapter\s+\d+/i.test(text)) {
           $(el).find("a").each((_, a) => {
             let h = $(a).attr("href");
             if (h) {
               const url = h.startsWith("http") ? h : new URL(h, novelUrl).href;
               if (!chapterLinks.includes(url)) chapterLinks.push(url);
             }
           });
        }
      });
    }

    // Strategy 2: Fallback to any link containing 'chapter' if nothing found
    if (chapterLinks.length === 0) {
      extractLinks("body");
    }

    // Strategy 2.5: Special handling for FreeWebNovel chapter listing
    if (chapterLinks.length === 0) {
       $("a").each((_, el) => {
         const text = $(el).text().toLowerCase();
         let href = $(el).attr("href");
         if (href && (text.includes("chapter") || href.includes("chapter-"))) {
            const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
            if (!chapterLinks.includes(url)) chapterLinks.push(url);
         }
       });
    }

    // Strategy 3: Check for subpages if still empty
    if (chapterLinks.length === 0 && novelUrl.includes("/novel/")) {
      const slug = novelUrl.split("/novel/")[1].split("/")[0].replace(/\/$/, "").replace(".html", "");
      const infoUrls = [
        `https://freewebnovel.com/novel/${slug}/`,
        `https://freewebnovel.com/novel/${slug}`,
        `https://freewebnovel.com/${slug}.html`,
        `https://freewebnovel.com/novel/${slug}.html`,
      ];
      
      for (const infoUrl of infoUrls) {
        if (chapterLinks.length > 0) break;
        try {
          const infoRes = await axios.get(infoUrl, { headers, timeout: 5000 });
          const $info = cheerio.load(infoRes.data);
          $info("a").each((_, el) => {
            let href = $info(el).attr("href");
            if (href && (href.includes("/chapter-") || href.includes("chapter-"))) {
              const url = href.startsWith("http") ? href : new URL(href, infoUrl).href;
              if (!chapterLinks.includes(url)) chapterLinks.push(url);
            }
          });
        } catch (e) {}
      }
    }

    // Strategy 1.8: Absolute last resort - visit the first chapter and try to navigate
    if (chapterLinks.length === 0) {
       const slugMatch = novelUrl.match(/\/novel\/([^\/]+)/);
       if (slugMatch) {
          const slug = slugMatch[1].replace(".html", "").replace(/\/$/, "");
          const firstChapterUrl = `https://freewebnovel.com/novel/${slug}/chapter-1.html`;
          chapterLinks.push(firstChapterUrl);
       }
    }

    // Strategy 1.9: Last ditch - check for novel chapters via a direct AJAX call pattern
    if (chapterLinks.length === 0) {
       const slugMatch = novelUrl.match(/\/novel\/([^\/]+)/);
       if (slugMatch) {
          const slug = slugMatch[1].replace(".html", "").replace(/\/$/, "");
          try {
             const ajaxUrl = `https://freewebnovel.com/novel-chapters/${slug}/`;
             const res = await axios.get(ajaxUrl, { 
               headers: {
                 ...headers,
                 "Referer": novelUrl
               }, 
               timeout: 5000,
               validateStatus: () => true
             });
             if (res.status === 200) {
               const $ajax = cheerio.load(res.data);
               $ajax("a").each((_, el) => {
                  let href = $ajax(el).attr("href");
                  if (href) {
                    const url = href.startsWith("http") ? href : new URL(href, ajaxUrl).href;
                    if (!chapterLinks.includes(url)) chapterLinks.push(url);
                  }
               });
             }
          } catch(e) {}
       }
    }

    // Strategy 1.95: Special handling for FreeWebNovel chapter list page
    if (chapterLinks.length === 0) {
       const slugMatch = novelUrl.match(/\/novel\/([^\/]+)/);
       if (slugMatch) {
          const slug = slugMatch[1].replace(".html", "").replace(/\/$/, "");
          const listUrls = [
             `https://freewebnovel.com/novel-chapters/${slug}.html`,
             `https://freewebnovel.com/novel-chapters/${slug}/`,
             `https://freewebnovel.com/chapters/${slug}/`,
             `https://freewebnovel.com/chapters/${slug}.html`,
             `https://freewebnovel.com/novel/${slug}/all-chapters.html`
          ];
          for (const listUrl of listUrls) {
             if (chapterLinks.length > 0) break;
             try {
                const res = await axios.get(listUrl, { headers, timeout: 5000 });
                const $list = cheerio.load(res.data);
                $list("a").each((_, el) => {
                   let href = $list(el).attr("href");
                   if (href && (href.includes("/chapter-") || href.includes("-chapter-"))) {
                      const url = href.startsWith("http") ? href : new URL(href, listUrl).href;
                      if (!chapterLinks.includes(url)) chapterLinks.push(url);
                   }
                });
             } catch(e) {}
          }
       }
    }

    // Final Fallback: Search all text for chapter links if still empty
    if (chapterLinks.length === 0) {
      console.log("No chapters found with primary strategies, performing global search...");
      $("a").each((_, el) => {
        const href = $(el).attr("href");
        if (href && (href.includes("chapter") || href.match(/\d+\.html$/))) {
          const url = href.startsWith("http") ? href : new URL(href, novelUrl).href;
          if (url.includes("freewebnovel.com") && !chapterLinks.includes(url)) {
            chapterLinks.push(url);
          }
        }
      });
    }

    // Sort chapter links numerically if possible
    chapterLinks = [...new Set(chapterLinks)];
    chapterLinks.sort((a, b) => {
      const getNum = (s) => {
        if (typeof s !== 'string') return 0;
        const m = s.match(/chapter-(\d+)/i) || s.match(/(\d+)\.html/i) || s.match(/(\d+)/i);
        return m ? parseInt(m[1]) : 0;
      };
      return getNum(a) - getNum(b);
    });

    const chaptersToScrape = chapterLinks.slice(0, limit);
    
    console.log(`Found ${chapterLinks.length} chapters, scraping ${chaptersToScrape.length}`);
    if (onProgress) onProgress(0, chaptersToScrape.length);

    if (chaptersToScrape.length === 0) {
      throw new Error("No chapters found after trying 10+ strategies");
    }

    const chapters = [];
    const concurrency = 5;
    for (let i = 0; i < chaptersToScrape.length; i += concurrency) {
      const batch = chaptersToScrape.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(url => scrapeChapterWithRetry(url, 3)));
      chapters.push(...results);
      if (onProgress) onProgress(Math.min(i + concurrency, chaptersToScrape.length), chaptersToScrape.length);
      await new Promise(r => setTimeout(r, 1000));
    }
    return chapters;
}

async function scrapeNovel(novelUrl, limit = 25, onProgress = null) {
  try {
    // Standardize URL: ensure it ends with / if it's the novel home page
    if (novelUrl.includes("/novel/") && !novelUrl.endsWith("/") && !novelUrl.endsWith(".html")) {
      novelUrl += "/";
    }

    // Try axios first
    let html = "";
    try {
      const { data } = await axios.get(novelUrl, { 
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "max-age=0",
          "Upgrade-Insecure-Requests": "1"
        },
        timeout: 10000,
        validateStatus: () => true
      });
      html = data;
    } catch (e) {
      console.log("Axios failed, trying playwright fallback...");
    }

    // If axios failed or returned empty/protected content, try playwright fallback
    if (!html || html.includes("Cloudflare") || html.includes("DDoS") || html.length < 5000) {
      console.log("Axios output suspicious or blocked, forcing Playwright fallback...");
      try {
        const { chromium } = require("playwright");
        const browser = await chromium.launch({ 
          headless: true,
          args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled'
          ]
        });
        const context = await browser.newContext({
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        });
        const page = await context.newPage();
        
        console.log(`Navigating to ${novelUrl} with browser...`);
        // Use a more reliable waitUntil
        await page.goto(novelUrl, { waitUntil: "commit", timeout: 60000 });
        await page.waitForTimeout(8000); // Give it plenty of time for challenges
        
        html = await page.content();
        await browser.close();
      } catch (pwErr) {
        console.error("Playwright also failed:", pwErr.message);
      }
    }

    if (!html) throw new Error("Could not retrieve website content");

    const $ = cheerio.load(html);

    const novelTitle = $("h1.novel-title").text().trim() ||
                       $(".novel-info h1").text().trim() ||
                       $(".title").text().trim() ||
                       $("h1").first().text().trim() || 
                       $("meta[property='og:title']").attr("content")?.split(" - ")[0]?.split(" | ")[0]?.trim() ||
                       "Novel";

    // Debug title extraction
    console.log(`Extracted Novel Title: "${novelTitle}" from URL: ${novelUrl}`);

    const chapters = await scrapeChaptersLogic($, novelUrl, limit, onProgress);
    return { novelTitle, chapters };
  } catch (err) {
    throw new Error(`Failed to scrape FreeWebNovel: ${err.message}`);
  }
}

module.exports = { scrapeNovel };
