import express from "express";
import fetch from "node-fetch";
import vm from "vm";

const app = express();
const port = 3011;

const YT_API = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false";

const headers = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.9",
  "x-youtube-client-name": "1",
  "x-youtube-client-version": "2.20251207.11.00",
};

function extractTitle(t) {
  if (!t) return null;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join("");
  if (t.text) return t.text;
  return null;
}

function findAllByKey(obj, keyToFind) {
  let results = [];
  if (!obj || typeof obj !== 'object') return results;
  if (obj[keyToFind]) results.push(obj);
  Object.keys(obj).forEach(key => {
    if (typeof obj[key] === 'object') {
      results = results.concat(findAllByKey(obj[key], keyToFind));
    }
  });
  return results;
}

async function convertImageToBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ext = url.endsWith(".jpg") ? "jpg" : "webp";
    return `data:image/${ext};base64,${Buffer.from(buf).toString("base64")}`;
  } catch (err) {
    return null;
  }
}

async function fetchThumbnailWithFallback(vid) {
  const urls = [
    `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    `https://i.ytimg.com/vi_webp/${vid}/default.webp`,
    `https://i.ytimg.com/vi/${vid}/default.jpg`
  ];
  for (const url of urls) {
    const data = await convertImageToBase64(url);
    if (data) return data;
  }
  return null;
}

async function extractInitialData(url) {
  try {
    const html = await fetch(url, { headers }).then((r) => r.text());
    const idx = html.indexOf("var ytInitialData =");
    if (idx === -1) throw new Error("ytInitialData not found");
    const start = html.indexOf("{", idx);
    const end = html.indexOf("};", start) + 1;
    const code = "ytInitialData=" + html.slice(start, end);
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx.ytInitialData;
  } catch (err) {
    throw err;
  }
}

async function fetchVideoInfo(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const data = await extractInitialData(url);

  const allVideoData = findAllByKey(data, "title");
  const mainVideo = allVideoData.find(v => extractTitle(v.title) && (v.viewCount || v.dateText)) || {};

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
          duration: extractTitle(v.lengthText) || "LIVE",
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
  const descParts = findAllByKey(data, "attributedDescription");
  if (descParts.length > 0) {
    description = extractTitle(descParts[0]);
  } else {
    const runs = findAllByKey(data, "runs")
      .map(r => r.runs.map(p => p.text).join(""))
      .filter(t => t.length > 50)
      .sort((a, b) => b.length - a.length)[0];
    description = runs || "";
  }

  return {
    videoId,
    title: extractTitle(mainVideo.title),
    thumbnail: await fetchThumbnailWithFallback(videoId),
    views: viewText,
    publishedDate: extractTitle(mainVideo.dateText) || extractTitle(mainVideo.publishDate),
    channel: {
      name: extractTitle(mainVideo.owner?.videoOwnerRenderer?.title),
      channelId: mainVideo.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId
    },
    description: description.slice(0, 1000),
    url,
    relatedVideos
  };
}

function getTokenFromAppendAction(json) {
  try {
    const items = json?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
    for (const it of items) {
      const token = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (token) return token;
    }
  } catch {}
  return "";
}

async function handleRDPlaylist(listId, videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&list=${listId}`;
  const data = await extractInitialData(url);
  const playlist = data.contents?.twoColumnWatchNextResults?.playlist?.playlist || null;
  if (!playlist) throw new Error("RD playlist not found");
  const rawItems = playlist.contents || [];
  const items = (await Promise.all(rawItems.map(async (entry) => {
    const v = entry.playlistPanelVideoRenderer;
    if (!v) return null;
    return {
      videoId: v.videoId,
      title: extractTitle(v.title),
      duration: v.lengthText?.simpleText || null,
      author: extractTitle(v.longBylineText),
      thumbnail: await fetchThumbnailWithFallback(v.videoId),
    };
  }))).filter(Boolean);
  return {
    playlistId: listId,
    title: extractTitle(playlist.title),
    items,
    url
  };
}

async function handleNormalPlaylist(listId, token) {
  const body = {
    context: { client: { hl: "ja", gl: "JP", clientName: "WEB", clientVersion: "2.20251207.11.00" } },
    browseId: "VL" + listId
  };
  if (token) body.continuation = token;
  const response = await fetch(YT_API, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await response.json();
  const firstPageItems = json?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];
  const extractVideo = async (arr) => (await Promise.all(arr.map(async (v) => {
    const data = v.playlistVideoRenderer;
    if (!data) return null;
    return {
      videoId: data.videoId,
      title: extractTitle(data.title),
      thumbnail: await fetchThumbnailWithFallback(data.videoId)
    };
  }))).filter(Boolean);
  const items = await extractVideo(firstPageItems);
  return {
    playlistId: listId,
    items,
    nextToken: getTokenFromAppendAction(json)
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

app.get("/playlist/:id", async (req, res) => {
  try {
    const listId = req.params.id;
    const videoId = req.query.v;
    const token = req.query.token;
    if (listId.startsWith("RD")) {
      return res.json(await handleRDPlaylist(listId, videoId));
    }
    res.json(await handleNormalPlaylist(listId, token));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
