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
  
  // ytInitialDataを取得
  const regex = /var ytInitialData\s*=\s*({.+?});/s;
  const match = html.match(regex);
  if (!match) throw new Error("ytInitialData not found");
  
  const data = JSON.parse(match[1]);
  
  // APIキーも抽出
  const keyRegex = /"INNERTUBE_API_KEY":"([^"]+)"/;
  const keyMatch = html.match(keyRegex);
  const apiKey = keyMatch ? keyMatch[1] : "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  
  return { data, apiKey };
}

async function fetchMoreRelated(continuation, apiKey) {
  const url = `https://www.youtube.com/youtubei/v1/next?key=${apiKey}`;
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
  // compactVideoRenderer または gridVideoRenderer から情報を抽出
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

app.get("/api/related/:videoid", async (req, res) => {
  try {
    const videoId = req.params.videoid;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const { data, apiKey } = await extractInitialData(url);
    
    const relatedVideos = [];
    const seenIds = new Set([videoId]);
    
    // 関連動画を抽出する関数
    function extractVideos(dataObj) {
      // compactVideoRenderer を探す（関連動画セクション）
      const compactRenderers = findAllByKey(dataObj, "compactVideoRenderer");
      for (const renderer of compactRenderers) {
        const video = extractVideoFromRenderer(renderer.compactVideoRenderer);
        if (video && !seenIds.has(video.videoId)) {
          relatedVideos.push(video);
          seenIds.add(video.videoId);
          if (relatedVideos.length >= 50) return;
        }
      }
      
      // gridVideoRenderer も探す
      const gridRenderers = findAllByKey(dataObj, "gridVideoRenderer");
      for (const renderer of gridRenderers) {
        const video = extractVideoFromRenderer(renderer.gridVideoRenderer);
        if (video && !seenIds.has(video.videoId)) {
          relatedVideos.push(video);
          seenIds.add(video.videoId);
          if (relatedVideos.length >= 50) return;
        }
      }
      
      // 念のため通常のvideoIdも探す
      const potentialVideos = findAllByKey(dataObj, "videoId");
      for (const v of potentialVideos) {
        const video = extractVideoFromRenderer(v);
        if (video && !seenIds.has(video.videoId)) {
          relatedVideos.push(video);
          seenIds.add(video.videoId);
          if (relatedVideos.length >= 50) return;
        }
      }
    }
    
    // 初期データから抽出
    extractVideos(data);
    
    // continuationで追加取得
    let continuation = findContinuationToken(data);
    let attempts = 0;
    const maxAttempts = 5;
    
    while (relatedVideos.length < 50 && continuation && attempts < maxAttempts) {
      attempts++;
      try {
        const moreData = await fetchMoreRelated(continuation, apiKey);
        extractVideos(moreData);
        continuation = findContinuationToken(moreData);
        
        // continuationが見つからない場合は終了
        if (!continuation) break;
      } catch (err) {
        console.error(`Attempt ${attempts} failed:`, err.message);
        break;
      }
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
