# Telegram WebNovel EPUB Bot

## Overview

A Telegram bot that scrapes web novels from various online sources and converts them into EPUB ebook files. Users send novel URLs via Telegram, and the bot extracts chapters, compiles them, and returns a downloadable EPUB file. The bot supports 14+ novel websites with a generic fallback scraper for unsupported sites.

**Supported novel sources:**
- FreeWebNovel, RoyalRoad, Webnovel, Wattpad
- NovelUpdates, ScribbleHub, Fanfiction.net
- Wuxiaworld, Archive of Our Own (AO3)
- Boxnovel, ReadLightNovel, NovelFull, MTLNovel
- Generic fallback scraper for unsupported sites

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Bot Framework
- **node-telegram-bot-api** handles all Telegram interactions using long-polling
- Entry point is `bot.js` which initializes the bot and database connection
- Bot token loaded from `BOT_TOKEN` environment variable

### Scraper Architecture
- **Modular design**: Each website has a dedicated scraper in `/scrapers/` directory
- All scrapers export a consistent `scrapeNovel(url, limit, onProgress)` function
- **axios** for HTTP requests, **cheerio** for HTML parsing
- **Playwright** available for JavaScript-heavy sites requiring browser automation
- Retry logic with exponential backoff (`scrapeChapterWithRetry`) handles transient failures
- Content validation requires >150 characters before accepting chapter content
- **Generic scraper** (`generic.js`) serves as fallback using common content selectors

### EPUB Generation
- **epub-gen** library creates EPUB files
- Builder in `/epub/builder.js` sanitizes filenames and formats chapter HTML
- Generated files stored in `/output/` directory

### Data Storage
- **PostgreSQL** database via `pg` library
- Connection string from `DATABASE_URL` environment variable with SSL enabled
- Library system in `/db/library.js` stores EPUB metadata per user:
  - title, author, source URL, chapter count, file path, cover URL, description
- Uses upsert pattern (INSERT ... ON CONFLICT DO UPDATE) for updates
- Indexed by user_id and created_at for efficient queries

### Key Design Patterns
- **Consistent scraper interface**: All scrapers follow same function signature for easy extensibility
- **Progress callbacks**: Scrapers accept `onProgress` callback for real-time user status updates
- **Retry with backoff**: All HTTP requests implement retry logic for reliability
- **Content validation**: Minimum content length checks prevent saving empty chapters

## External Dependencies

### Required Environment Variables
- `BOT_TOKEN` - Telegram Bot API token (required)
- `DATABASE_URL` - PostgreSQL connection string (required for library features)

### Third-Party Services
- **Telegram Bot API** - User interaction and file delivery
- **PostgreSQL** - User library and EPUB metadata storage

### NPM Dependencies
- `node-telegram-bot-api` - Telegram bot framework
- `axios` - HTTP client for scraping
- `cheerio` - HTML parsing and DOM manipulation
- `epub-gen` - EPUB file generation
- `pg` - PostgreSQL client
- `playwright` - Browser automation for JavaScript-heavy sites
- `dotenv` - Environment variable loading