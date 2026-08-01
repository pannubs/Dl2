const express = require('express');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
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
  { name: "movies4u.gr", baseUrl: "https://movies4u.gr", searchPath: "/?s=" },
  { name: "worldfree4u.dev", baseUrl: "https://worldfree4u.dev", searchPath: "/?s=" },
  { name: "bollyflix.ski", baseUrl: "https://bollyflix.ski", searchPath: "/?s=" }
];

// Helper fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// --- ROUTE 1: Serve Frontend UI ---
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html;charset=UTF-8');
  res.send(getHTML());
});

// --- ROUTE 2: Direct Search on Target Domains ---
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query parameter" });

  try {
    const searchPromises = targetDomains.map(domain => searchTargetDomain(domain, query));
    const searchResultsArrays = await Promise.all(searchPromises);
    const combinedResults = searchResultsArrays.flat();

    return res.json({ results: combinedResults });
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
    const domainName = new URL(targetUrl).hostname;
    const scrapeResult = await scrapeTargetPage(targetUrl, domainName, title);
    return res.json(scrapeResult);
  } catch (err) {
    return res.status(500).json({ error: "Scraping route execution failed" });
  }
});

/**
 * Search Handler using Cheerio
 */
async function searchTargetDomain(domainConfig, query) {
  try {
    const searchPath = domainConfig.searchPath || "/?s=";
    const searchUrl = `${domainConfig.baseUrl}${searchPath}${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, { headers: stealthHeaders, redirect: "follow" }, 8000);

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
      "movies-by-size", "bollywood", "hollywood", "/page/", "netflix", "amazon-prime", 
      "hotstar", "hulu", "voot", "mx-player", "anime", "korean-drama", "ongoing-series", 
      "request", "credits", "/movies/", "/south-hindi-dubbed/", "/hindi-dubbed/", "/web-series/"
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

        if (anchorTitle.length > 2) {
          foundItems.push({ url: fullUrl, title: anchorTitle, domain: domainConfig.name });
        }
      }
    });

    const uniqueMap = new Map();
    foundItems.forEach(item => uniqueMap.set(item.url, item));
    return Array.from(uniqueMap.values());

  } catch (error) {
    return [];
  }
}

/**
 * Scraper Handler using Cheerio
 */
async function scrapeTargetPage(targetUrl, domainName, cleanTitle) {
  try {
    const postRes = await fetchWithTimeout(targetUrl, { headers: stealthHeaders, redirect: "follow" }, 10000);
    if (!postRes.ok) {
      return { title: cleanTitle, domain: domainName, status: "error", error: `HTTP ${postRes.status}`, links: [], screenshots: [] };
    }

    const rawHtml = await postRes.text();
    if (rawHtml.includes("Just a moment...") || rawHtml.includes("challenge-platform")) {
      return { title: cleanTitle, domain: domainName, status: "error", error: "Target page blocked by verification screens.", links: [], screenshots: [] };
    }

    const $ = cheerio.load(rawHtml);
    const extractedLinks = [];
    const extractedScreenshots = [];

    const socialJunk = [
      "telegram", "whatsapp", "instagram", "facebook", "twitter", "t.me", 
      "pinterest", "linkedin", "imdb.com", "imdb", "youtube.com", "youtu.be", "trailer"
    ];

    // 1. Extract Screenshots
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && (src.includes('postimg') || src.includes('imgur') || /\.(jpg|jpeg|png|webp)/i.test(src))) {
        if (!src.includes('logo') && !src.includes('avatar') && !src.includes('header')) {
          extractedScreenshots.push(src);
        }
      }
    });

    // 2. Extract Download Links
    let currentHeading = "Download Option";

    $('h1, h2, h3, h4, p, strong, b, a').each((_, el) => {
      const tagName = el.tagName.toLowerCase();
      const text = $(el).text().replace(/\s+/g, ' ').trim();

      // Only update quality headers on headings or short text lines
      if (tagName !== 'a' && text.length > 5 && text.length < 90 && /480p|720p|1080p|2160p|4k|mb|gb|hindi|english/i.test(text)) {
        if (!['download now', 'click here'].some(w => text.toLowerCase().includes(w))) {
          currentHeading = text;
        }
      }

      if (tagName === 'a') {
        const href = $(el).attr('href');
        if (!href) return;

        const lowerHref = href.toLowerCase();
        const internalDomain = domainName.split('.')[0].replace("www.", "");
        const isInternal = lowerHref.includes(internalDomain) || href.startsWith("/");
        const isSocial = socialJunk.some(word => lowerHref.includes(word));

        if (!isInternal && !isSocial && lowerHref.startsWith("http")) {
          const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(lowerHref) || lowerHref.includes("postimg") || lowerHref.includes("imgur");
          
          if (isImage) {
            extractedScreenshots.push(href);
          } else {
            const anchorText = text.length > 3 ? text : currentHeading;
            extractedLinks.push({ url: href, title: anchorText });
          }
        }
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
    return { title: cleanTitle, domain: domainName, status: "error", error: error.message, links: [], screenshots: [] };
  }
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prism Aggregator v2</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --accent: #10b981; --btn: #3b82f6; }
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); padding: 2rem 1rem; max-width: 850px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 2rem; letter-spacing: -0.05em; font-size: 2.2rem; color: #f1f5f9; }
        .search-box { display: flex; gap: 10px; margin-bottom: 2rem; }
        input { flex: 1; padding: 14px; border-radius: 8px; border: 1px solid #334155; background: var(--card); color: white; font-size: 1rem; outline: none; }
        input:focus { border-color: var(--btn); }
        button { padding: 14px 24px; border-radius: 8px; border: none; background: var(--btn); color: white; cursor: pointer; font-weight: bold; font-size: 1rem; transition: background 0.2s; white-space: nowrap; }
        button:hover { background: #2563eb; }
        .btn-back { background: #475569; padding: 8px 16px; font-size: 0.9rem; margin-bottom: 15px; display: inline-block; border-radius: 6px; }
        .btn-back:hover { background: #334155; }
        .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
        .search-result-card { background: var(--card); padding: 16px; border-radius: 8px; cursor: pointer; transition: transform 0.2s, border-color 0.2s; border: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
        .search-result-card:hover { transform: translateX(4px); border-color: var(--btn); }
        .source-badge { background: #0284c7; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; color: #ffffff; font-family: monospace; font-weight: 600; }
        .results-container { margin-top: 1rem; background: var(--card); padding: 25px; border-radius: 12px; display: none; border: 1px solid #334155; }
        .link-item { display: flex; justify-content: space-between; align-items: center; color: var(--text); margin: 12px 0; background: #0f172a; padding: 16px; border-radius: 8px; border-left: 5px solid var(--accent); transition: transform 0.15s, background 0.2s; gap: 10px; }
        .link-item:hover { background: #020617; transform: translateX(4px); }
        .link-info { flex: 1; word-break: break-all; }
        .link-title { font-weight: 600; color: #f8fafc; display: block; margin-bottom: 5px; font-size: 1.05rem; line-height: 1.4; }
        .link-url { font-size: 0.8rem; color: #64748b; font-family: monospace; }
        .copy-btn { background: #334155; padding: 8px 12px; font-size: 0.8rem; border-radius: 6px; }
        .copy-btn:hover { background: #475569; }
        .gallery-wrap { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 25px; margin-top: 10px; }
        .screenshot-img { max-width: 100%; width: 240px; border-radius: 6px; border: 1px solid #334155; cursor: zoom-in; object-fit: cover; aspect-ratio: 16/9; transition: transform 0.2s; }
        .screenshot-img:hover { transform: scale(1.03); border-color: var(--btn); }
        .loader { text-align: center; padding: 3rem; display: none; color: #94a3b8; font-style: italic; font-size: 1.1rem; }
    </style>
</head>
<body>
    <h1>Prism Aggregator</h1>
    <div class="search-box">
        <input type="text" id="searchInput" placeholder="Type movie name to search target domains directly..." onkeypress="if(event.key === 'Enter') searchMovies()">
        <button onclick="searchMovies()">Search Domains</button>
    </div>
    <div id="loader" class="loader">Loading...</div>
    <div id="movieGrid" class="grid"></div>
    <div id="scrapeResults" class="results-container">
        <button class="btn-back" onclick="backToResults()">← Back to Results</button>
        <h2 id="selectedMovieTitle" style="margin-top:0; margin-bottom: 20px; border-bottom: 1px solid #334155; padding-bottom: 10px;"></h2>
        <div id="downloadLinks"></div>
    </div>
    <script>
        let cachedSearchResults = [];

        async function searchMovies() {
            const query = document.getElementById("searchInput").value.trim();
            if (!query) return;
            document.getElementById("movieGrid").innerHTML = "";
            document.getElementById("scrapeResults").style.display = "none";
            document.getElementById("loader").style.display = "block";
            document.getElementById("loader").innerText = "Querying website catalogs directly...";
            try {
                const res = await fetch("/api/search?q=" + encodeURIComponent(query));
                const data = await res.json();
                document.getElementById("loader").style.display = "none";
                if (data.results && data.results.length > 0) {
                    cachedSearchResults = data.results;
                    renderSearchResults(data.results);
                } else {
                    document.getElementById("movieGrid").innerHTML = "<p style='text-align:center; color:#94a3b8;'>No direct posts found matching that name on targeted domains.</p>";
                }
            } catch (error) {
                document.getElementById("loader").style.display = "none";
                alert("Search transaction failed.");
            }
        }

        function renderSearchResults(results) {
            const grid = document.getElementById("movieGrid");
            grid.innerHTML = "";
            grid.style.display = "grid";
            results.forEach(item => {
                const card = document.createElement("div");
                card.className = "search-result-card";
                card.innerHTML = "<strong style='color: #f1f5f9; padding-right: 15px;'>" + escapeHTML(item.title) + "</strong>" +
                                 "<span class='source-badge'>" + escapeHTML(item.domain) + "</span>";
                card.onclick = () => initiateScrape(item.url, item.title);
                grid.appendChild(card);
            });
        }

        async function initiateScrape(targetUrl, title) {
            document.getElementById("movieGrid").style.display = "none";
            document.getElementById("loader").style.display = "block";
            document.getElementById("loader").innerText = "Parsing target page content for download nodes...";
            try {
                const res = await fetch("/api/scrape?url=" + encodeURIComponent(targetUrl) + "&title=" + encodeURIComponent(title));
                const source = await res.json();
                document.getElementById("loader").style.display = "none";
                document.getElementById("scrapeResults").style.display = "block";
                document.getElementById("selectedMovieTitle").innerText = source.title;
                const linksContainer = document.getElementById("downloadLinks");
                linksContainer.innerHTML = "";
                
                if (source.status === "success" && source.screenshots && source.screenshots.length > 0) {
                    let galleryHTML = "<h4 style='margin: 0 0 10px 0; color:#cbd5e1;'>Movie Screen Previews</h4><div class='gallery-wrap'>";
                    source.screenshots.forEach((screenUrl) => {
                        galleryHTML += "<img src='" + escapeHTML(screenUrl) + "' class='screenshot-img' onclick=\"window.open('" + escapeHTML(screenUrl) + "', '_blank')\" title='Click to view full size'>";
                    });
                    galleryHTML += "</div>";
                    linksContainer.innerHTML += galleryHTML;
                }
                
                linksContainer.innerHTML += "<h4 style='margin: 20px 0 10px 0; color:#cbd5e1; border-top: 1px solid #334155; padding-top: 15px;'>Discovered Download Pathways</h4>";
                if (source.status === "success") {
                    if (source.links && source.links.length > 0) {
                        source.links.forEach(linkObj => {
                            const itemDiv = document.createElement("div");
                            itemDiv.className = "link-item";
                            itemDiv.innerHTML = 
                                "<div class='link-info'>" +
                                    "<a href='" + escapeHTML(linkObj.url) + "' target='_blank' style='text-decoration:none;'>" +
                                        "<span class='link-title'>" + escapeHTML(linkObj.title) + "</span>" +
                                        "<span class='link-url'>" + escapeHTML(linkObj.url) + "</span>" +
                                    "</a>" +
                                "</div>" +
                                "<button class='copy-btn' onclick=\"copyToClipboard('" + escapeHTML(linkObj.url) + "', this)\">Copy</button>";
                            linksContainer.appendChild(itemDiv);
                        });
                    } else {
                        linksContainer.innerHTML += "<p style='color: #cfd8dc; font-size:0.85rem;'>No file download paths found inside this page structure.</p>";
                    }
                } else {
                    linksContainer.innerHTML += "<p style='color: #ef4444; font-size: 0.9rem; padding: 10px; background:#2d1b22; border-radius:6px; border-left:4px solid #ef4444;'>" + escapeHTML(source.error || "Failed to extract items from page.") + "</p>";
                }
            } catch (error) {
                document.getElementById("loader").style.display = "none";
                alert("Scraping handler encountered an error.");
            }
        }

        function backToResults() {
            document.getElementById("scrapeResults").style.display = "none";
            document.getElementById("movieGrid").style.display = "grid";
        }

        function copyToClipboard(text, btn) {
            navigator.clipboard.writeText(text).then(() => {
                const orig = btn.innerText;
                btn.innerText = "Copied!";
                setTimeout(() => btn.innerText = orig, 1500);
            });
        }

        function escapeHTML(str) {
            return String(str || '').replace(/[&<>"']/g, function(m) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
            });
        }
    </script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
