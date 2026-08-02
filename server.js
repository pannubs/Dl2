const express = require('express');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

// Essential headers to prevent blocks
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

// Globally enable CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// ROUTE 1: Aggregator Search Node
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const searchPromises = targetDomains.map(domain => searchTargetDomain(domain, query));
    const searchResultsArrays = await Promise.all(searchPromises);
    return res.json({ results: searchResultsArrays.flat() });
  } catch (err) {
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
    return res.status(500).json({ error: "Scraping route execution failed" });
  }
});

// ----------------------------------------------------
// Aggressive Search Parser (Bypasses structural changes)
// ----------------------------------------------------
async function searchTargetDomain(domainConfig, query) {
  try {
    const searchUrl = `${domainConfig.baseUrl}${domainConfig.searchPath}${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, { headers: stealthHeaders, redirect: "follow" });
    if (!response.ok) return [];
    
    const rawHtml = await response.text();
    if (rawHtml.includes("challenge-platform")) return []; // Stop on Cloudflare block
    
    const $ = cheerio.load(rawHtml);
    const foundItems = [];
    const internalDomain = domainConfig.name.split('.')[0];
    
    // Scan all anchors on the page
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      
      const lowerHref = href.toLowerCase();
      const isInternal = lowerHref.includes(internalDomain) || href.startsWith("/");
      
      // Strict blacklist REMOVED. Now we just ignore obvious garbage UI links.
      const isJunk = ['/author/', '/category/', '/tag/', '/contact', 'login', 'register'].some(w => lowerHref.includes(w));
      
      if (isInternal && !isJunk && lowerHref.length > 25) {
        const fullUrl = href.startsWith("/") ? `${domainConfig.baseUrl}${href}` : href;
        
        // Grab title from standard WordPress headings or anchor text
        let anchorTitle = $(element).find('h2, h3, h1, .title').text().replace(/\s+/g, ' ').trim() || $(element).text().replace(/\s+/g, ' ').trim() || $(element).attr('title');
        
        // Brute force image discovery by scanning nearest parent structure
        let imgTag = $(element).find('img').first();
        if(!imgTag.length) imgTag = $(element).closest('article, .post, .item, .result-item, div').find('img').first();
        
        let image = imgTag.attr('data-src') || imgTag.attr('data-lazy-src') || imgTag.attr('src');
        if (image && !image.startsWith("http") && !image.startsWith("data:")) image = `${domainConfig.baseUrl}${image}`;

        if (anchorTitle && anchorTitle.length > 3) {
          foundItems.push({ url: fullUrl, title: anchorTitle, domain: domainConfig.name, image: image });
        }
      }
    });

    // Deduplicate array based on unique URLs
    const uniqueMap = new Map();
    foundItems.forEach(item => uniqueMap.set(item.url, item));
    return Array.from(uniqueMap.values());
  } catch (error) {
    return [];
  }
}

// ----------------------------------------------------
// Aggressive File Extractor (Brute-Forces external links)
// ----------------------------------------------------
async function scrapeTargetPage(targetUrl, domainName, cleanTitle) {
  try {
    const postRes = await fetch(targetUrl, { headers: stealthHeaders, redirect: "follow" });
    if (!postRes.ok) return { status: "error", error: `HTTP ${postRes.status}`, links: [], screenshots: [] };
    
    const rawHtml = await postRes.text();
    if (rawHtml.includes("challenge-platform")) return { status: "error", error: "Cloudflare Blocked Request", links: [], screenshots: [] };

    const $ = cheerio.load(rawHtml);
    const extractedLinks = [];
    const extractedScreenshots = [];

    // 1. Extract Screenshots (Ignore site logos and tiny icons)
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && (src.includes('postimg') || src.includes('imgur') || /\.(jpg|jpeg|png|webp)/i.test(src))) {
        if (!src.toLowerCase().includes('logo') && !src.toLowerCase().includes('avatar') && !src.toLowerCase().includes('icon')) {
          extractedScreenshots.push(src);
        }
      }
    });

    // 2. Extract Download Pathways (Scan EVERYTHING for external links)
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      let text = $(el).text().replace(/\s+/g, ' ').trim() || 'Download Asset';
      if (!href || href.startsWith('#') || href.startsWith('javascript')) return;
      
      const lowerHref = href.toLowerCase();
      
      // Determine if link points away from the website
      const isInternal = lowerHref.includes(domainName.split('.')[0]) || href.startsWith("/");
      // Ignore social media share buttons
      const isSocial = ['whatsapp', 'telegram', 'facebook', 'twitter', 't.me', 'imdb.com', 'youtube.com', 'pinterest'].some(w => lowerHref.includes(w));

      // If it is an external link, it is almost certainly a download redirector (e.g. Mega, GDrive, DropLink, etc.)
      if (!isInternal && !isSocial && href.startsWith("http")) {
        // Try to glean quality context from nearby text if anchor is just a "Download" button
        if(text.toLowerCase() === 'download') {
           const parentText = $(el).parent().text().toLowerCase();
           if(parentText.includes('1080p')) text = 'Download (1080p)';
           if(parentText.includes('720p')) text = 'Download (720p)';
           if(parentText.includes('480p')) text = 'Download (480p)';
        }
        extractedLinks.push({ url: href, title: text });
      }
    });

    const uniqueLinksMap = new Map();
    extractedLinks.forEach(item => uniqueLinksMap.set(item.url, item));

    return {
      title: cleanTitle,
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
