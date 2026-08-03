const express = require('express');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

// Stealth headers to bypass basic detection
const stealthHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5"
};

// Target piracy databases
const targetDomains = [
  { name: "filmevde.com", baseUrl: "https://filmevde.com", searchPath: "/?s=" },
  { name: "cinevoods.com", baseUrl: "https://cinevoods.com", searchPath: "/?s=" },
  { name: "bolly-in.com", baseUrl: "https://bolly-in.com", searchPath: "/?s=" }
];

// Enable CORS Globally
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Root Route Notice
app.get('/', (req, res) => {
  res.send("PRISM Aggregator API Node is Live.");
});

// ROUTE 1: Aggregator Multi-Domain Search
app.get('/api/search', async (req, res) => {
  let query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query parameter" });

  // Clean special characters (colons, dashes, etc.) that break WordPress search
  query = query.replace(/[:\-\'\"]/g, ' ').replace(/\s+/g, ' ').trim();

  try {
    const searchPromises = targetDomains.map(domain => searchTargetDomain(domain, query));
    const searchResultsArrays = await Promise.all(searchPromises);
    const combined = searchResultsArrays.flat();
    return res.json({ results: combined });
  } catch (err) {
    console.error("Search routing error:", err);
    return res.status(500).json({ error: "Search routing aggregation failed" });
  }
});

// ROUTE 2: Aggregator Link Extractor
app.get('/api/scrape', async (req, res) => {
  const targetUrl = req.query.url;
  const title = req.query.title;
  if (!targetUrl) return res.status(400).json({ error: "Missing target URL" });

  try {
    const domainName = new URL(targetUrl).hostname.replace('www.', '');
    const scrapeResult = await scrapeTargetPage(targetUrl, domainName, title);
    return res.json(scrapeResult);
  } catch (err) {
    console.error("Scrape route error:", err);
    return res.status(500).json({ error: "Scraping route execution failed" });
  }
});

/**
 * Searches Target Domains (Safely extracts post links without deleting category subfolders)
 */
async function searchTargetDomain(domainConfig, query) {
  try {
    const searchUrl = `${domainConfig.baseUrl}${domainConfig.searchPath}${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, { headers: stealthHeaders, redirect: "follow" });
    if (!response.ok) return [];
    
    const rawHtml = await response.text();
    if (rawHtml.includes("challenge-platform") || rawHtml.includes("Just a moment...")) return []; 
    
    const $ = cheerio.load(rawHtml);
    const foundItems = [];
    const internalDomain = domainConfig.name.split('.')[0];
    
    // Only exclude TRUE system/static pages (REMOVED 'dual-audio-movies', '720p-movies', etc.)
    const systemExclusions = [
      '/category/', '/tag/', '/author/', '/contact', '/about', '/dmca', '/disclaimer',
      '/privacy-policy', '/terms', '/page/', '/genre/', '/year/', '/quality/',
      '/wp-includes/', '/wp-content/', 'login', 'register'
    ];

    // Scan for post elements across WordPress card layouts
    $('article, .post, .result-item, .entry, .movie-card, h2.entry-title, h2.post-title').each((_, container) => {
      const $container = $(container);
      const linkEl = $container.is('a') ? $container : $container.find('a[href]').first();
      const href = linkEl.attr('href');
      if (!href) return;
      
      const lowerHref = href.toLowerCase();
      const isInternal = lowerHref.includes(internalDomain) || href.startsWith("/");
      const isSystemPage = systemExclusions.some(p => lowerHref.includes(p));
      
      if (isInternal && !isSystemPage && lowerHref.length > 20) {
        const fullUrl = href.startsWith("/") ? `${domainConfig.baseUrl}${href}` : href;
        
        let title = $container.find('h1, h2, h3, .entry-title, .post-title, .title').text().trim() ||
                    linkEl.text().trim() ||
                    linkEl.attr('title') || '';
        
        title = title.replace(/\s+/g, ' ').trim();

        let imgTag = $container.find('img').first();
        let image = imgTag.attr('data-src') || imgTag.attr('data-lazy-src') || imgTag.attr('src');
        if (image && !image.startsWith("http") && !image.startsWith("data:")) {
          image = `${domainConfig.baseUrl}${image}`;
        }

        if (title && title.length > 3) {
          foundItems.push({
            url: fullUrl,
            title: title,
            domain: domainConfig.name,
            image: image || null
          });
        }
      }
    });

    // Deduplicate by URL
    const uniqueMap = new Map();
    foundItems.forEach(item => uniqueMap.set(item.url, item));
    return Array.from(uniqueMap.values());
  } catch (error) {
    console.error(`[${domainConfig.name}] Search Error:`, error.message);
    return [];
  }
}

/**
 * Extracts Outbound File Links & Combines Page Header + Option Text
 */
async function scrapeTargetPage(targetUrl, domainName, cleanTitle) {
  try {
    const postRes = await fetch(targetUrl, { headers: stealthHeaders, redirect: "follow" });
    if (!postRes.ok) return { status: "error", error: `HTTP ${postRes.status}`, links: [], screenshots: [] };
    
    const rawHtml = await postRes.text();
    if (rawHtml.includes("challenge-platform")) return { status: "error", error: "Cloudflare Blocked Request", links: [], screenshots: [] };

    const $ = cheerio.load(rawHtml);
    const extractedLinks = [];
    const extractedScreenshots = [];

    // Extract page main header title
    let pageTitle = $('h1.entry-title, h1.post-title, h1.title, h1').first().text().replace(/\s+/g, ' ').trim();
    if (!pageTitle || pageTitle.length < 5) pageTitle = cleanTitle || "Movie File";

    // Extract Screenshots (Skip small UI icons and site logos)
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (src && (src.includes('postimg') || src.includes('imgur') || src.includes('screenshot') || /\.(jpg|jpeg|png|webp)/i.test(src))) {
        const lowerSrc = src.toLowerCase();
        if (!lowerSrc.includes('logo') && !lowerSrc.includes('avatar') && !lowerSrc.includes('icon')) {
          const fullImg = src.startsWith('/') ? `https://${domainName}${src}` : src;
          extractedScreenshots.push(fullImg);
        }
      }
    });

    const socialJunk = ['whatsapp', 'telegram', 'facebook', 'twitter', 't.me', 'imdb.com', 'youtube.com', 'pinterest', 'instagram'];

    // Extract Outbound Links
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript')) return;
      
      const lowerHref = href.toLowerCase();
      const isInternal = lowerHref.includes(domainName.split('.')[0]) || href.startsWith("/");
      const isSocial = socialJunk.some(w => lowerHref.includes(w));

      if (!isInternal && !isSocial && href.startsWith("http")) {
        let linkBtnText = $(el).text().replace(/\s+/g, ' ').trim();
        
        const genericNames = ['download', 'download now', 'click here', 'get link', 'link', 'download asset'];
        if (!linkBtnText || genericNames.includes(linkBtnText.toLowerCase())) {
          const parentText = $(el).closest('p, div, li, td').text().replace(/\s+/g, ' ').trim();
          if (parentText && parentText.length < 90) {
            linkBtnText = parentText;
          } else {
            linkBtnText = "Direct Download Option";
          }
        }

        const fullDescriptiveTitle = `${pageTitle} — ${linkBtnText}`;
        extractedLinks.push({ url: href, title: fullDescriptiveTitle });
      }
    });

    const uniqueLinksMap = new Map();
    extractedLinks.forEach(item => uniqueLinksMap.set(item.url, item));

    return {
      title: pageTitle,
      domain: domainName,
      status: "success",
      links: Array.from(uniqueLinksMap.values()),
      screenshots: [...new Set(extractedScreenshots)]
    };
  } catch (error) {
    return { status: "error", error: error.message, links: [], screenshots: [] };
  }
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
