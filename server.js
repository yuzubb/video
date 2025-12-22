import express from "express";
import fetch from "node-fetch";

const app = express();
const port = 3011;

const headers = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ja,en;q=0.9",
};

function extractTitle(t) {
  if (!t) return "";
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join("");
  return "";
}

function findAllByKey(obj, keyToFind) {
  let results = [];
  if (!obj || typeof obj !== 'object') return results;
  if (obj[keyToFind] !== undefined) results.push(obj);
  Object.keys(obj).forEach(key => {
    if (typeof obj[key] === 'object') {
      results = results.concat(findAllByKey(obj[key], keyToFind));
    }
  });
  return results;
}

async function extractInitialData(url) {
  const res = await fetch(url, { headers });
  const html = await res.text();
  const regex = /var ytInitialData\s*=\s*({.+?});/s;
  const match = html.match(regex);
  if (!match) throw new Error("ytInitialData not found");
  return JSON.parse(match[1]);
}

app.get("/api/related/:videoid", async (req, res) => {
  try {
    const videoId = req.params.videoid;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const data = await extractInitialData(url);

    const potentialVideos = findAllByKey(data, "videoId");
    const relatedVideos = [];
    const seenIds = new Set([videoId]);

    for (const v of potentialVideos) {
      const vid = v.videoId;
      if (vid && !seenIds.has(vid)) {
        const title = extractTitle(v.title) || extractTitle(v.headline);
        
        if (title) {
          relatedVideos.push({
            videoId: vid,
            title: title,
            thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            duration: extractTitle(v.lengthText) || extractTitle(v.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text) || "",
            views: extractTitle(v.viewCountText) || extractTitle(v.shortViewCountText),
            published: extractTitle(v.publishedTimeText),
            author: {
              name: extractTitle(v.shortBylineText) || extractTitle(v.longBylineText) || extractTitle(v.ownerText),
              channelId: v.navigationEndpoint?.browseEndpoint?.browseId || v.channelId
            }
          });
          seenIds.add(vid);
        }
      }
      if (relatedVideos.length >= 40) break;
    }

    res.json({
      baseVideoId: videoId,
      count: relatedVideos.length,
      relatedVideos
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("Related Videos API is running"));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
