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

function findAllByKey(obj, keyToFind, maxDepth = 50, currentDepth = 0) {
  let results = [];
  if (!obj || typeof obj !== 'object' || currentDepth > maxDepth) return results;
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      results = results.concat(findAllByKey(item, keyToFind, maxDepth, currentDepth + 1));
    }
    return results;
  }
  
  if (obj[keyToFind] !== undefined) results.push(obj);
  
  Object.keys(obj).forEach(key => {
    if (typeof obj[key] === 'object') {
      results = results.concat(findAllByKey(obj[key], keyToFind, maxDepth, currentDepth + 1));
    }
  });
  return results;
}

function findContinuationToken(obj) {
  const continuations = findAllByKey(obj, "continuationCommand");
  for (const c of continuations) {
    const token = c.continuationCommand?.token || c.token;
    if (token && typeof token === 'string') {
      return token;
    }
  }
  
  const continuations2 = findAllByKey(obj, "continuation");
  for (const c of continuations2) {
    if (c.continuation && typeof c.continuation === 'string') {
      return c.continuation;
    }
  }
  return null;
}

async function extractInitialData(url) {
  const res = await fetch(url, { headers });
  const html = await res.text();
  
  const regex = /var ytInitialData\s*=\s*({.+?});/s;
  const match = html.match(regex);
  if (!match) throw new Error("ytInitialData not found");
  
  const data = JSON.parse(match[1]);
  
  const keyRegex = /"INNERTUBE_API_KEY":"([^"]+)"/;
  const keyMatch = html.match(keyRegex);
  const apiKey = keyMatch ? keyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  
  return { data, apiKey };
}

async function fetchMoreVideos(continuation, apiKey) {
  const url = `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`;
  const body = {
    continuation: continuation,
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20231201.00.00"
      }
    }
  };
  
  const res = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body)
  });
  
  return await res.json();
}

function extractVideoFromRenderer(v) {
  const vid = v.videoId;
  if (!vid) return null;
  
  const title = extractTitle(v.title) || extractTitle(v.headline);
  if (!title) return null;
  
  return {
    videoId: vid,
    title: title,
    thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    duration: extractTitle(v.lengthText) || extractTitle(v.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text) || "",
    views: extractTitle(v.viewCountText) || extractTitle(v.shortViewCountText) || "",
    published: extractTitle(v.publishedTimeText) || "",
    author: {
      name: extractTitle(v.shortBylineText) || extractTitle(v.longBylineText) || extractTitle(v.ownerText) || "",
      channelId: v.navigationEndpoint?.browseEndpoint?.browseId || v.channelId || ""
    }
  };
}

app.get("/api/trending", async (req, res) => {
  try {
    const url = "https://www.youtube.com";
    const { data, apiKey } = await extractInitialData(url);
    
    const videos = [];
    const seenIds = new Set();
    
    function extractVideos(dataObj) {
      // richItemRenderer (ホーム画面の動画)
      const richItems = findAllByKey(dataObj, "richItemRenderer");
      for (const item of richItems) {
        const content = item.richItemRenderer?.content?.videoRenderer;
        if (content) {
          const video = extractVideoFromRenderer(content);
          if (video && !seenIds.has(video.videoId)) {
            videos.push(video);
            seenIds.add(video.videoId);
          }
        }
      }
      
      // gridVideoRenderer
      const gridRenderers = findAllByKey(dataObj, "gridVideoRenderer");
      for (const renderer of gridRenderers) {
        const video = extractVideoFromRenderer(renderer.gridVideoRenderer);
        if (video && !seenIds.has(video.videoId)) {
          videos.push(video);
          seenIds.add(video.videoId);
        }
      }
      
      // videoRenderer (一般的な動画レンダラー)
      const videoRenderers = findAllByKey(dataObj, "videoRenderer");
      for (const renderer of videoRenderers) {
        const video = extractVideoFromRenderer(renderer.videoRenderer);
        if (video && !seenIds.has(video.videoId)) {
          videos.push(video);
          seenIds.add(video.videoId);
        }
      }
    }
    
    extractVideos(data);
    
    let continuation = findContinuationToken(data);
    let attempts = 0;
    const maxAttempts = 20;
    
    while (continuation && attempts < maxAttempts) {
      attempts++;
      try {
        const moreData = await fetchMoreVideos(continuation, apiKey);
        const prevCount = videos.length;
        extractVideos(moreData);
        
        const newContinuation = findContinuationToken(moreData);
        
        if (!newContinuation || videos.length === prevCount) {
          break;
        }
        
        continuation = newContinuation;
      } catch (err) {
        console.error(`Attempt ${attempts} failed:`, err.message);
        break;
      }
    }
    
    res.json({
      count: videos.length,
      attempts: attempts,
      videos
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("YouTube Trending Videos API is running"));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
