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
  if (t.text) return t.text;
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

async function fetchVideoInfo(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const data = await extractInitialData(url);

  const allTitles = findAllByKey(data, "title");
  const mainVideo = allTitles.find(v => extractTitle(v.title) && (v.viewCount || v.dateText)) || {};

  const viewText = findAllByKey(data, "viewCount")
    .map(v => extractTitle(v.viewCount) || v.viewCount?.videoViewCountRenderer?.viewCount?.simpleText)
    .find(t => t) || "0 回視聴";

  const potentialVideos = findAllByKey(data, "videoId");
  const relatedVideos = [];
  const seenIds = new Set([videoId]);

  for (const v of potentialVideos) {
    if (v.videoId && !seenIds.has(v.videoId)) {
      const title = extractTitle(v.title) || extractTitle(v.headline);
      if (title) {
        relatedVideos.push({
          videoId: v.videoId,
          title: title,
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          duration: extractTitle(v.lengthText) || "",
          views: extractTitle(v.viewCountText) || extractTitle(v.shortViewCountText),
          publishedDate: extractTitle(v.publishedTimeText),
          channel: {
            name: extractTitle(v.shortBylineText) || extractTitle(v.longBylineText) || extractTitle(v.ownerText),
            channelId: v.navigationEndpoint?.browseEndpoint?.browseId || v.channelId
          }
        });
        seenIds.add(v.videoId);
      }
    }
    if (relatedVideos.length >= 20) break;
  }

  let description = "";
  const structuredDesc = findAllByKey(data, "structuredDescriptionContentRenderer");
  if (structuredDesc.length > 0) {
    const runs = findAllByKey(structuredDesc[0], "runs");
    description = runs.map(r => Array.isArray(r.runs) ? r.runs.map(p => p.text).join("") : "").join("\n");
  }

  if (!description || description.length < 10) {
    const descParts = findAllByKey(data, "attributedDescription");
    description = descParts.length > 0 ? extractTitle(descParts[0]) : "";
  }

  if (!description || description.length < 10) {
    const allRuns = findAllByKey(data, "runs");
    description = allRuns
      .map(r => Array.isArray(r.runs) ? r.runs.map(p => p.text).join("") : "")
      .filter(t => t.length > 30)
      .sort((a, b) => b.length - a.length)[0] || "";
  }

  const owner = findAllByKey(data, "videoOwnerRenderer")[0]?.videoOwnerRenderer;

  return {
    videoId,
    title: extractTitle(mainVideo.title) || "Untitled",
    thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    views: viewText,
    publishedDate: extractTitle(mainVideo.dateText) || extractTitle(mainVideo.publishDate) || "",
    channel: {
      name: extractTitle(owner?.title) || extractTitle(mainVideo.shortBylineText) || "Unknown",
      channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId || ""
    },
    description: description.trim(),
    url,
    relatedVideos
  };
}

app.get("/api/video/:videoid", async (req, res) => {
  try {
    const info = await fetchVideoInfo(req.params.videoid);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("Video API is running"));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
