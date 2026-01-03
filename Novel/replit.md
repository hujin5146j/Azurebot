# Telegram WebNovel EPUB Bot

## Overview

This is a Telegram bot that scrapes web novels from various online sources and converts them into EPUB ebook files. Users can send novel URLs from supported websites, and the bot will extract chapters, compile them, and return a downloadable EPUB file. The bot also includes a personal library system for users to store and manage their converted novels.

**Supported novel sources include:**
- FreeWebNovel, RoyalRoad, Webnovel, Wattpad
- NovelUpdates, ScribbleHub, Fanfiction.net
- Wuxiaworld, Archive of Our Own (AO3)
- Boxnovel, ReadLightNovel, NovelFull, MTLNovel
- Generic fallback scraper for unsupported sites

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Bot Framework
- **node-telegram-bot-api**: Handles all Telegram bot interactions using long-polling mode
- Entry point is `bot.js` which initializes the bot and database connection
- Bot token loaded from `BOT_TOKEN` environment variable

### Scraping Architecture
- **Modular scraper design**: Each supported website has its own dedicated scraper in `/scrapers/`
- All scrapers follow a consistent interface exporting a `scrapeNovel()` function
- Uses **axios** for HTTP requests and **cheerio** for HTML parsing
- Implements retry logic with exponential backoff (`scrapeChapterWithRetry`)
- **Playwright** available for JavaScript-heavy sites requiring browser automation
- **Generic scraper** serves as fallback for unsupported sites using common content selectors

### EPUB Generation
- **epub-gen** library handles EPUB file creation
- Builder in `/epub/builder.js` sanitizes filenames and formats chapter content
- Generated files stored in `/output/` directory

### Data Storage
- **PostgreSQL** database using the `pg` library
- Connection via `DATABASE_URL` environment variable with SSL enabled
- **Library system** stores user EPUB metadata (title, author, source URL, chapter count, file path)
- Uses upsert pattern (INSERT ... ON CONFLICT DO UPDATE) for updating existing entries
- Indexed by user_id and created_at for efficient queries

### Key Design Patterns
- **Scraper abstraction**: Consistent interface across all scrapers allows easy addition of new sources
- **Retry with backoff**: All scrapers implement retry logic to handle transient failures
- **Progress callbacks**: Scrapers accept `onProgress` callback for real-time status updates to users
- **Content validation**: Scrapers verify content length before accepting (>150 chars minimum)

## External Dependencies

### Environment Variables Required
- `BOT_TOKEN`: Telegram Bot API token (required)
- `DATABASE_URL`: PostgreSQL connection string with SSL (required for library features)

### Third-Party Services
- **Telegram Bot API**: Core messaging platform
- **PostgreSQL Database**: User library persistence (hosted externally, e.g., Railway, Supabase)

### External Websites Scraped
The bot interacts with various novel hosting websites. These are external dependencies that may change their structure, requiring scraper updates.

### NPM Dependencies
- `node-telegram-bot-api`: Telegram bot framework
- `axios`: HTTP client for web scraping
- `cheerio`: HTML parsing/DOM manipulation
- `epub-gen`: EPUB file generation
- `pg`: PostgreSQL client
- `playwright`: Headless browser for JavaScript-rendered content