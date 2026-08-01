const express = require('express');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const stealthHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "max-age=0"
};

const targetDomains = [
  { name: "movies4u.gr", alias: "Database One", baseUrl: "https://movies4u.gr", searchPath: "/?s=" },
  { name: "worldfree4u.dev", alias: "Database Two", baseUrl: "https://worldfree4u.dev", searchPath: "/?s=" },
  { name: "bollyflix.ski", alias: "Database Three", baseUrl: "https://bollyflix.ski", searchPath: "/?s=" }
];

// --- ROUTE 1: Serve Frontend UI ---
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html;charset=UTF-8');
  res.send(getHTML());
});

// --- ROUTE 2: Direct Search on Target Domains ---
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const startTime = Date.now();
    const searchPromises = targetDomains.map(domain => searchTargetDomain(domain, query));
    const searchResultsArrays = await Promise.all(searchPromises);
    const combinedResults = searchResultsArrays.flat();
    const endTime = Date.now();

    return res.json({
      results: combinedResults,
      timeTaken: ((endTime - startTime) / 1000).toFixed(2)
    });
  } catch (err) {
    return res.status(500).json({ error: "Search routing aggregation failed" });
  }
});

// --- ROUTE 3: Precise Direct-URL Extraction ---
app.get('/api/scrape', async (req, res) => {
  const targetUrl = req.query.url;
  const title = req.query.title || "Selected Item";
  if (!targetUrl) return res.status(400).json({ error: "Missing target URL" });

  try {
    const scrapeResult = await scrapeTargetPage(targetUrl, title);
    return res.json(scrapeResult);
  } catch (err) {
    return res.status(500).json({ error: "Scraping route execution failed" });
  }
});

/**
 * Queries a site's native search engine and extracts valid movie links + featured images using Cheerio
 */
async function searchTargetDomain(domainConfig, query) {
  try {
    const searchPath = domainConfig.searchPath || "/?s=";
    const searchUrl = `${domainConfig.baseUrl}${searchPath}${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, { headers: stealthHeaders, redirect: "follow" });

    if (!response.ok) return [];

    const rawHtml = await response.text();
    if (rawHtml.includes("Just a moment...") || rawHtml.includes("challenge-platform")) {
      return [];
    }

    const $ = cheerio.load(rawHtml);
    const foundItems = [];

    const blacklist = [
      "category", "tag", "author", "contact", "about", "how-to-download", "?s=",
      "wp-content", "login", "register", "dmca", "disclaimer", "privacy", "policy",
      "terms", "faq", "comment", "movies-by-year", "movies-by-genre", "adult-movies",
      "dual-audio-movies", "multi-audio", "punjabi", "bengali", "quality", "size",
      "movies-by-size", "bollywood", "hollywood", "/page/",
      "netflix", "amazon-prime", "hotstar", "hulu", "voot", "mx-player", "anime",
      "korean-drama", "ongoing-series", "request", "credits", "/movies/",
      "/south-hindi-dubbed/", "/hindi-dubbed/", "/web-series/"
    ];

    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      const lowerHref = href.toLowerCase();
      const internalDomain = domainConfig.name.split('.')[0].replace("www.", "");
      const isInternal = lowerHref.includes(internalDomain) || href.startsWith("/");
      const isBlacklisted = blacklist.some(word => lowerHref.includes(word));

      if (isInternal && !isBlacklisted && lowerHref.length > 25) {
        const fullUrl = href.startsWith("/") ? `${domainConfig.baseUrl}${href}` : href;
        let anchorTitle = $(element).text().replace(/\s+/g, ' ').trim();

        if (anchorTitle.length <= 5) {
          try {
            const urlObj = new URL(fullUrl);
            let slug = urlObj.pathname.split('/').filter(Boolean).pop() || "";
            slug = slug.replace(".html", "").replace(".php", "");
            if (slug && slug.length > 5) {
              anchorTitle = slug.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
          } catch (e) {}
        }

        // Extract featured image from link or parent article
        let imgSrc = null;
        const $img = $(element).find('img').first().length ? $(element).find('img').first() : $(element).closest('article, div, li').find('img').first();
        if ($img.length) {
          let src = $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src');
          if (src && !src.includes('data:image') && !src.includes('avatar') && !src.includes('logo')) {
            imgSrc = src.startsWith('/') ? `${domainConfig.baseUrl}${src}` : src;
          }
        }

        if (anchorTitle.length > 2) {
          foundItems.push({
            url: fullUrl,
            title: anchorTitle,
            domain: domainConfig.alias,
            image: imgSrc
          });
        }
      }
    });

    const uniqueMap = new Map();
    foundItems.forEach(item => {
      if (uniqueMap.has(item.url)) {
        const existing = uniqueMap.get(item.url);
        if (item.title.length > existing.title.length) existing.title = item.title;
        if (item.image && !existing.image) existing.image = item.image;
      } else {
        uniqueMap.set(item.url, item);
      }
    });

    return Array.from(uniqueMap.values()).filter(item => item.title.length > 2);

  } catch (error) {
    return [];
  }
}

/**
 * Scrapes selected target page for download links and screenshots
 */
async function scrapeTargetPage(targetUrl, cleanTitle) {
  const domainName = new URL(targetUrl).hostname.replace('www.', '');
  let displayAlias = "External Database";
  if (domainName.includes("movies4u")) displayAlias = "Database One";
  if (domainName.includes("worldfree4u")) displayAlias = "Database Two";
  if (domainName.includes("bollyflix")) displayAlias = "Database Three";

  try {
    const postRes = await fetch(targetUrl, { headers: stealthHeaders, redirect: "follow" });
    if (!postRes.ok) {
      return { title: cleanTitle, domain: displayAlias, status: "error", error: `HTTP ${postRes.status}`, links: [], screenshots: [] };
    }

    const rawHtml = await postRes.text();
    if (rawHtml.includes("Just a moment...") || rawHtml.includes("challenge-platform")) {
      return { title: cleanTitle, domain: displayAlias, status: "error", error: "Target page blocked by verification screens.", links: [], screenshots: [] };
    }

    const $ = cheerio.load(rawHtml);
    const extractedLinks = [];
    const extractedScreenshots = [];

    const socialJunk = [
      "telegram", "whatsapp", "instagram", "facebook", "twitter", "t.me",
      "pinterest", "linkedin", "imdb.com", "imdb", "youtube.com", "youtu.be", "trailer"
    ];

    // Extract Screenshots
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (src && (src.includes('postimg') || src.includes('imgur') || /\.(jpg|jpeg|png|webp)/i.test(src))) {
        if (!src.includes('logo') && !src.includes('avatar') && !src.includes('header')) {
          const fullSrc = src.startsWith('/') ? `https://${domainName}${src}` : src;
          extractedScreenshots.push(fullSrc);
        }
      }
    });

    // Extract Download Links
    let lastValidHeading = "Download Option";

    $('h1, h2, h3, h4, p, div, strong, b, a').each((_, el) => {
      const tagName = el.tagName.toLowerCase();
      const text = $(el).text().replace(/\s+/g, ' ').trim();

      if (tagName !== 'a' && text.length > 5 && text.length < 100 && /480p|720p|1080p|2160p|4k|mb|gb|hindi|english/i.test(text)) {
        if (!['download now', 'click here'].some(w => text.toLowerCase().includes(w))) {
          lastValidHeading = text;
        }
      }

      if (tagName === 'a') {
        const href = $(el).attr('href');
        if (!href) return;

        const lowerHref = href.toLowerCase();
        const internalDomain = domainName.split('.')[0];
        const isInternal = lowerHref.includes(internalDomain) || href.startsWith("/");
        const isSocial = socialJunk.some(word => lowerHref.includes(word));

        if (!isInternal && !isSocial && lowerHref.startsWith("http")) {
          const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(lowerHref) || lowerHref.includes("postimg") || lowerHref.includes("imgur");

          if (isImage) {
            extractedScreenshots.push(href);
          } else {
            const anchorText = text.length > 3 ? text : lastValidHeading;
            let displayTitle = lastValidHeading;
            if (anchorText.length > 3 && anchorText !== lastValidHeading) {
              displayTitle = lastValidHeading !== "Download Option" ? `${lastValidHeading} (${anchorText})` : anchorText;
            }
            extractedLinks.push({ url: href, title: displayTitle });
          }
        }
      }
    });

    const uniqueLinksMap = new Map();
    extractedLinks.forEach(item => uniqueLinksMap.set(item.url, item));

    return {
      title: cleanTitle,
      domain: displayAlias,
      status: "success",
      links: Array.from(uniqueLinksMap.values()),
      screenshots: [...new Set(extractedScreenshots)]
    };

  } catch (error) {
    return { title: cleanTitle, domain: displayAlias, status: "error", error: error.message, links: [], screenshots: [] };
  }
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#09090b">
    <title>PRISM - Premium Aggregator</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-base: #09090b;
            --glass-bg: rgba(24, 24, 27, 0.65);
            --glass-border: rgba(255, 255, 255, 0.08);
            --accent-primary: #f97316; 
            --accent-secondary: #8b5cf6; 
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --radius-xl: 24px;
            --radius-lg: 16px;
            --radius-md: 12px;
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
        body { font-family: "Plus Jakarta Sans", system-ui, sans-serif; background-color: var(--bg-base); color: var(--text-main); line-height: 1.5; overflow-x: hidden; }
        body.modal-open { overflow: hidden; }
        
        /* Animated Live Grid Background */
        .ambient-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; background-color: #050505; }
        .grid-overlay { position: absolute; inset: -50%; background-image: linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px); background-size: 40px 40px; transform: perspective(500px) rotateX(60deg) translateY(0); animation: gridMove 15s linear infinite; }
        @keyframes gridMove { 0% { transform: perspective(500px) rotateX(60deg) translateY(0); } 100% { transform: perspective(500px) rotateX(60deg) translateY(40px); } }
        .orb { position: absolute; border-radius: 50%; filter: blur(90px); opacity: 0.45; animation: float 14s infinite alternate ease-in-out; }
        .orb-1 { top: -15%; left: -10%; width: 50vw; height: 50vw; max-width: 500px; max-height: 500px; background: var(--accent-secondary); }
        .orb-2 { bottom: -10%; right: -5%; width: 60vw; height: 60vw; max-width: 600px; max-height: 600px; background: var(--accent-primary); animation-delay: -5s; animation-direction: alternate-reverse; }
        @keyframes float { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(10%, 15%) scale(1.1); } }
        
        /* App Layout */
        .app-shell { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem 6rem 1.5rem; min-height: 100vh; }
        .header { text-align: center; margin-bottom: 2rem; padding-top: 1rem; }
        .logo-text { font-size: 2.5rem; font-weight: 800; letter-spacing: 4px; background: linear-gradient(135deg, #fff, #a1a1aa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-transform: uppercase; margin-bottom: 0.5rem; }
        .subtitle { color: var(--text-muted); font-size: 0.95rem; font-weight: 500; letter-spacing: 1px; }
        
        /* Search Bar & Suggestions */
        .search-container { position: relative; margin-bottom: 1.5rem; z-index: 10; }
        .search-box { display: flex; align-items: center; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 100px; padding: 0.5rem 0.5rem 0.5rem 1.5rem; backdrop-filter: blur(20px); box-shadow: 0 8px 32px rgba(0,0,0,0.3); transition: border-color 0.3s, box-shadow 0.3s; }
        .search-box:focus-within { border-color: rgba(249, 115, 22, 0.4); box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 4px rgba(249, 115, 22, 0.1); }
        .search-box input { flex: 1; background: transparent; border: none; color: white; font-size: 1.1rem; font-weight: 500; outline: none; width: 100%; font-family: inherit; }
        .search-box input::placeholder { color: #52525b; font-weight: 400; }
        .search-btn { background: linear-gradient(135deg, var(--accent-primary), #d946ef); color: white; border: none; border-radius: 100px; padding: 1rem 2rem; font-weight: 600; font-size: 1rem; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; box-shadow: 0 4px 15px rgba(249, 115, 22, 0.3); }
        .search-btn:active { transform: scale(0.95); }
        .suggestions { display: flex; gap: 0.75rem; overflow-x: auto; padding-bottom: 1.5rem; scrollbar-width: none; -ms-overflow-style: none; }
        .suggestions::-webkit-scrollbar { display: none; }
        .tag { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 0.5rem 1rem; border-radius: 100px; font-size: 0.85rem; color: var(--text-muted); cursor: default; white-space: nowrap; backdrop-filter: blur(10px); display: flex; align-items: center; }
        .tag-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-primary); margin-right: 8px; }
        
        /* Telemetry Stats Dashboard */
        .stats-dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-bottom: 3rem; }
        .stat-card { background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: var(--radius-lg); padding: 1.5rem; display: flex; align-items: center; gap: 1.2rem; backdrop-filter: blur(12px); }
        .stat-icon { position: relative; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; }
        .stat-info { display: flex; flex-direction: column; }
        .stat-value { font-size: 1.25rem; font-weight: 800; color: #fff; margin-bottom: 0.2rem; letter-spacing: -0.5px; }
        .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700; letter-spacing: 1px; }
        
        /* Stat Animations */
        .svg-circle { transform: rotate(-90deg); width: 100%; height: 100%; }
        .svg-circle circle { fill: none; stroke-width: 4; stroke-linecap: round; }
        .svg-bg { stroke: rgba(255,255,255,0.1); }
        .svg-progress { stroke: var(--accent-primary); stroke-dasharray: 120; stroke-dashoffset: 120; animation: drawCircle 2s ease-out forwards; }
        @keyframes drawCircle { to { stroke-dashoffset: 30; } }
        
        .wave-bars { display: flex; gap: 3px; align-items: flex-end; height: 24px; }
        .wave-bar { width: 4px; background: var(--accent-secondary); border-radius: 2px; animation: wave 1.2s ease-in-out infinite alternate; }
        .wave-bar:nth-child(1) { height: 12px; animation-delay: 0.1s; }
        .wave-bar:nth-child(2) { height: 24px; animation-delay: 0.2s; }
        .wave-bar:nth-child(3) { height: 16px; animation-delay: 0.3s; }
        .wave-bar:nth-child(4) { height: 8px; animation-delay: 0.4s; }
        @keyframes wave { 0% { transform: scaleY(0.5); } 100% { transform: scaleY(1); } }
        
        .pulse-dot { width: 12px; height: 12px; background: #10b981; border-radius: 50%; box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); animation: pulse 2s infinite; margin: 0 auto; }
        @keyframes pulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); } 70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }
        
        /* Poster Grid System */
        .section-title { font-size: 1.25rem; font-weight: 700; margin: 2rem 0 1rem 0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1rem; }
        @media (min-width: 600px) { .grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1.5rem; } }
        
        .poster-card { aspect-ratio: 2/3; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: var(--radius-lg); overflow: hidden; position: relative; cursor: pointer; display: flex; flex-direction: column; justify-content: flex-end; padding: 1.25rem; transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.3s; animation: fadeUp 0.5s ease-out backwards; backdrop-filter: blur(10px); }
        .poster-card:hover { transform: translateY(-8px) scale(1.02); box-shadow: 0 15px 30px rgba(0,0,0,0.5), 0 0 20px rgba(139, 92, 246, 0.2); border-color: rgba(255,255,255,0.25); z-index: 2; }
        
        .poster-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; transition: transform 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .poster-card:hover .poster-img { transform: scale(1.1) rotate(-1deg); }
        .poster-bg-gradient { position: absolute; inset: 0; opacity: 0.4; z-index: 0; transition: opacity 0.3s; }
        .poster-card:hover .poster-bg-gradient { opacity: 0.6; }
        
        .poster-overlay { position: absolute; inset: 0; background: linear-gradient(to top, rgba(9,9,11,1) 0%, rgba(9,9,11,0.6) 40%, transparent 100%); z-index: 1; transition: background 0.3s; }
        .poster-card:hover .poster-overlay { background: linear-gradient(to top, rgba(9,9,11,1) 0%, rgba(9,9,11,0.4) 60%, transparent 100%); }
        
        .poster-content { position: relative; z-index: 2; }
        .poster-title { font-weight: 700; font-size: 1.1rem; line-height: 1.2; margin-bottom: 0.5rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 2px 8px rgba(0,0,0,1); color: #fff; }
        .poster-domain { font-size: 0.75rem; font-weight: 600; color: rgba(255,255,255,0.9); text-transform: uppercase; letter-spacing: 0.5px; background: rgba(0,0,0,0.6); padding: 4px 8px; border-radius: 6px; display: inline-block; backdrop-filter: blur(4px); box-shadow: 0 2px 4px rgba(0,0,0,0.5); }
        
        .skeleton-card { aspect-ratio: 2/3; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: var(--radius-lg); position: relative; overflow: hidden; }
        .skeleton-card::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent); transform: translateX(-100%); animation: shimmer 1.5s infinite; }
        @keyframes shimmer { 100% { transform: translateX(100%); } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        
        /* Modal Split Layout */
        .modal { position: fixed; inset: 0; z-index: 100; background: var(--bg-base); display: flex; flex-direction: column; transform: translateY(100%); transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1); pointer-events: none; }
        .modal.open { transform: translateY(0); pointer-events: all; }
        .modal-header { padding: 1.5rem; display: flex; align-items: center; gap: 1rem; border-bottom: 1px solid rgba(255,255,255,0.05); background: rgba(9, 9, 11, 0.8); backdrop-filter: blur(20px); position: sticky; top: 0; z-index: 10; }
        .close-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); width: 44px; height: 44px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; cursor: pointer; transition: background 0.2s; }
        .modal-title { font-size: 1.2rem; font-weight: 700; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
        .modal-body { flex: 1; overflow-y: auto; padding: 0 1.5rem 5rem 1.5rem; }
        
        .modal-hero { display: flex; gap: 1.5rem; padding: 2rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 2rem; }
        @media (max-width: 600px) { .modal-hero { flex-direction: column; align-items: center; text-align: center; } }
        .modal-poster-wrap { width: 140px; aspect-ratio: 2/3; border-radius: var(--radius-md); overflow: hidden; flex-shrink: 0; box-shadow: 0 10px 30px rgba(0,0,0,0.5); background: var(--glass-bg); border: 1px solid rgba(255,255,255,0.1); position: relative; }
        .modal-poster-wrap img { width: 100%; height: 100%; object-fit: cover; }
        .modal-info { display: flex; flex-direction: column; justify-content: center; }
        .modal-info-title { font-size: 1.8rem; font-weight: 800; line-height: 1.2; margin-bottom: 0.75rem; }
        .scraping-indicator { display: inline-flex; align-items: center; gap: 10px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); color: #10b981; padding: 8px 14px; border-radius: 100px; font-size: 0.85rem; font-weight: 600; margin-top: 1rem; width: fit-content; }
        @media (max-width: 600px) { .scraping-indicator { margin: 1rem auto 0 auto; } }
        
        .section-label { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-muted); font-weight: 700; margin-bottom: 1rem; display: block; }
        .gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2.5rem; }
        .screenshot { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: var(--radius-md); border: 1px solid rgba(255,255,255,0.1); cursor: zoom-in; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
        
        .download-list { display: flex; flex-direction: column; gap: 0.75rem; }
        .dl-btn { display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 1.25rem 1.5rem; border-radius: var(--radius-lg); text-decoration: none; color: white; transition: all 0.2s ease; position: relative; overflow: hidden; }
        .dl-btn::before { content: ""; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: var(--accent-primary); opacity: 0.5; }
        .dl-btn:hover { background: rgba(255,255,255,0.06); transform: translateX(4px); }
        .dl-title { font-weight: 700; font-size: 1.05rem; }
        .dl-url { font-size: 0.75rem; color: var(--text-muted); opacity: 0.8; }
        .status-msg { padding: 1.5rem; border-radius: var(--radius-md); text-align: center; font-weight: 500; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); }
        .status-msg.error { background: rgba(239, 68, 68, 0.1); color: #f87171; }
    </style>
</head>
<body>
    <div class="ambient-bg">
        <div class="grid-overlay"></div>
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
    </div>
    
    <div class="app-shell">
        <header class="header">
            <h1 class="logo-text">PRISM</h1>
            <div class="subtitle">Multi-Source Movie Database</div>
        </header>
        
        <div class="search-container">
            <div class="search-box">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 10px;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input type="text" id="searchInput" placeholder="Search target databases..." onkeypress="if(event.key === 'Enter') executeSearch()">
                <button class="search-btn" onclick="executeSearch()">Search</button>
            </div>
        </div>
        
        <div class="suggestions">
            <div class="tag"><span class="tag-dot"></span>Database One</div>
            <div class="tag"><span class="tag-dot" style="background: #eab308;"></span>Database Two</div>
            <div class="tag"><span class="tag-dot" style="background: #3b82f6;"></span>Database Three</div>
        </div>
        
        <div class="stats-dashboard">
            <div class="stat-card">
                <div class="stat-icon">
                    <svg class="svg-circle" viewBox="0 0 40 40">
                        <circle class="svg-bg" cx="20" cy="20" r="16"></circle>
                        <circle class="svg-progress" cx="20" cy="20" r="16"></circle>
                    </svg>
                    <span style="position:absolute; font-size:0.8rem;">🎥</span>
                </div>
                <div class="stat-info">
                    <span class="stat-value">1,00,000+</span>
                    <span class="stat-label">Indexed Movies</span>
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon" style="background: rgba(139, 92, 246, 0.1); border-radius: 50%;">
                    <div class="wave-bars">
                        <div class="wave-bar"></div><div class="wave-bar"></div>
                        <div class="wave-bar"></div><div class="wave-bar"></div>
                    </div>
                </div>
                <div class="stat-info">
                    <span class="stat-value">1,00,000+</span>
                    <span class="stat-label">Web Series</span>
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon">
                    <div class="pulse-dot"></div>
                </div>
                <div class="stat-info">
                    <span class="stat-value" id="engineSpeed">Live</span>
                    <span class="stat-label">Aggregation Speed</span>
                </div>
            </div>
        </div>
        
        <h3 class="section-label section-title" id="resultsTitle" style="display:none;">Discovered Assets</h3>
        <div id="resultsGrid" class="grid"></div>
    </div>
    
    <div id="detailModal" class="modal">
        <div class="modal-header">
            <button class="close-btn" onclick="closeModal()">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </button>
            <div class="modal-title">Database Node Viewer</div>
        </div>
        <div class="modal-body" id="modalBody"></div>
    </div>
    
    <script>
        function getGradientForTitle(title) {
            const colors = [
                ["#ec4899", "#8b5cf6"], ["#f97316", "#eab308"], ["#06b6d4", "#3b82f6"],
                ["#10b981", "#0ea5e9"], ["#8b5cf6", "#3b82f6"], ["#f43f5e", "#f97316"]
            ];
            const hash = title.split("").reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0);
            const colorPair = colors[Math.abs(hash) % colors.length];
            return "linear-gradient(145deg, " + colorPair[0] + ", " + colorPair[1] + ")";
        }
        
        function renderSkeletons(containerId, count) {
            const container = document.getElementById(containerId);
            container.innerHTML = "";
            for(let i=0; i<count; i++) {
                container.innerHTML += '<div class="skeleton-card"></div>';
            }
        }
        
        async function executeSearch() {
            const query = document.getElementById("searchInput").value;
            if (!query) return;
            
            document.getElementById("engineSpeed").innerText = "---";
            document.getElementById("resultsTitle").style.display = "block";
            const grid = document.getElementById("resultsGrid");
            renderSkeletons("resultsGrid", 8);
            
            try {
                const res = await fetch("/api/search?q=" + encodeURIComponent(query));
                const data = await res.json();
                
                if(data.timeTaken) {
                    document.getElementById("engineSpeed").innerText = data.timeTaken + "s";
                }
                
                grid.innerHTML = "";
                if (data.results && data.results.length > 0) {
                    data.results.forEach((item, idx) => {
                        const delay = idx * 0.05;
                        let visualElement = "";
                        const safeImg = item.image ? encodeURIComponent(item.image) : "";
                        
                        if (item.image) {
                            visualElement = '<img src="' + item.image + '" class="poster-img" loading="lazy" alt="Cover">';
                        } else {
                            visualElement = '<div class="poster-bg-gradient" style="background: ' + getGradientForTitle(item.title) + '"></div>';
                        }
                        
                        grid.innerHTML += 
                            '<div class="poster-card" style="animation-delay: ' + delay + 's" onclick="openDetail(\'' + encodeURIComponent(item.url) + '\', \'' + encodeURIComponent(item.title) + '\', \'' + item.domain + '\', \'' + safeImg + '\')">' +
                                visualElement +
                                '<div class="poster-overlay"></div>' +
                                '<div class="poster-content">' +
                                    '<div class="poster-title">' + item.title + '</div>' +
                                    '<div class="poster-domain">' + item.domain + '</div>' +
                                '</div>' +
                            '</div>';
                    });
                } else {
                    grid.innerHTML = '<div class="status-msg" style="grid-column: 1/-1;">No direct assets located across indexed databases.</div>';
                }
            } catch (error) {
                grid.innerHTML = '<div class="status-msg error" style="grid-column: 1/-1;">Connection anomaly during search execution.</div>';
            }
        }
        
        async function openDetail(urlEncoded, titleEncoded, domain, imageEncoded) {
            const url = decodeURIComponent(urlEncoded);
            const title = decodeURIComponent(titleEncoded);
            const imageUrl = imageEncoded ? decodeURIComponent(imageEncoded) : null;
            
            const modal = document.getElementById("detailModal");
            const modalBody = document.getElementById("modalBody");
            
            modal.classList.add("open");
            document.body.classList.add("modal-open");
            
            let heroImageHtml = imageUrl 
                ? '<img src="' + imageUrl + '" alt="Poster">' 
                : '<div style="width:100%; height:100%; background:' + getGradientForTitle(title) + '; opacity:0.6;"></div>';
                
            modalBody.innerHTML = 
                '<div class="modal-hero">' +
                    '<div class="modal-poster-wrap">' + heroImageHtml + '</div>' +
                    '<div class="modal-info">' +
                        '<h2 class="modal-info-title">' + title + '</h2>' +
                        '<div><span class="tag" style="display:inline-block; margin-bottom: 5px;">Source: ' + domain + '</span></div>' +
                        '<div class="scraping-indicator">' +
                            '<span class="pulse-dot" style="width:8px; height:8px; margin:0;"></span> Extracting Download Nodes...' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div id="scrapeResultsArea">' +
                    '<div class="skeleton-card" style="height: 60px; margin-bottom: 10px;"></div>' +
                    '<div class="skeleton-card" style="height: 60px; margin-bottom: 10px;"></div>' +
                '</div>';
            
            try {
                const res = await fetch("/api/scrape?url=" + encodeURIComponent(url) + "&title=" + encodeURIComponent(title));
                const source = await res.json();
                
                const resultsArea = document.getElementById("scrapeResultsArea");
                let html = "";
                
                if (source.status === "success" && source.screenshots && source.screenshots.length > 0) {
                    html += '<span class="section-label">Media Previews</span><div class="gallery-grid">';
                    source.screenshots.forEach(screenUrl => {
                        const isDirectImage = /\\.(jpg|jpeg|png|webp)$/i.test(screenUrl);
                        if (isDirectImage) {
                            html += '<img src="' + screenUrl + '" class="screenshot" onclick="window.open(\'' + screenUrl + '\', \'_blank\')" loading="lazy">';
                        } else {
                            html += '<a href="' + screenUrl + '" target="_blank" class="tag" style="text-align:center; padding: 2rem 1rem; justify-content:center;">View Frame Asset<br><span style="font-size:1.2rem; margin-top:5px;">🖼️</span></a>';
                        }
                    });
                    html += '</div>';
                }
                
                html += '<span class="section-label">Extracted Pathways</span>';
                
                if (source.status === "success") {
                    if (source.links && source.links.length > 0) {
                        html += '<div class="download-list">';
                        source.links.forEach(linkObj => {
                            html += 
                                '<a href="' + linkObj.url + '" target="_blank" class="dl-btn">' +
                                    '<div class="dl-info">' +
                                        '<span class="dl-title">' + linkObj.title + '</span>' +
                                        '<span class="dl-url">' + linkObj.url.substring(0, 50) + (linkObj.url.length > 50 ? "..." : "") + '</span>' +
                                    '</div>' +
                                    '<div style="background:rgba(255,255,255,0.1); border-radius:50%; width:32px; height:32px; display:flex; align-items:center; justify-content:center;">' +
                                        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>' +
                                    '</div>' +
                                '</a>';
                        });
                        html += '</div>';
                    } else {
                        html += '<div class="status-msg">No extraction paths successfully resolved.</div>';
                    }
                } else {
                    html += '<div class="status-msg error">' + (source.error || "Scraping routine failed.") + '</div>';
                }
                
                const indicator = document.querySelector(".scraping-indicator");
                if (indicator) {
                    indicator.innerHTML = '<span style="color:#94a3b8">Extraction Complete</span>';
                    indicator.style.background = "rgba(255,255,255,0.05)";
                    indicator.style.borderColor = "rgba(255,255,255,0.1)";
                    indicator.style.color = "#94a3b8";
                }
                
                resultsArea.innerHTML = html;
                
            } catch (error) {
                document.getElementById("scrapeResultsArea").innerHTML = '<div class="status-msg error">Scraping handler encountered an exception.</div>';
            }
        }
        
        function closeModal() {
            document.getElementById("detailModal").classList.remove("open");
            document.body.classList.remove("modal-open");
        }
    </script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
