import express from "express";
import fetch from "node-fetch";

const app = express();
const port = 3012;

const YT_PLAYER_API = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const YT_NEXT_API = "https://www.youtube.com/youtubei/v1/next?prettyPrint=false";

const headers = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "x-youtube-client-name": "1",
  "x-youtube-client-version": "2.20251207.11.00",
  "Origin": "https://www.youtube.com",
  "Referer": "https://www.youtube.com/",
};

// ユーティリティ: テキスト抽出
function extractText(t) {
  if (!t) return null;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join("");
  return null;
}

// ユーティリティ: 画像Base64変換
async function convertImageToBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ext = url.includes(".webp") ? "webp" : "jpg";
    return `data:image/${ext};base64,${Buffer.from(buf).toString("base64")}`;
  } catch (err) {
    return null;
  }
}

async function fetchThumbnailWithFallback(vid) {
  const qualities = ["maxresdefault", "hqdefault", "mqdefault", "default"];
  for (const q of qualities) {
    const url = `https://i.ytimg.com/vi/${vid}/${q}.jpg`;
    const data = await convertImageToBase64(url);
    if (data) return data;
  }
  return null;
}

// メインロジック: 動画詳細と関連動画の取得
async function getVideoWithRelated(videoId) {
  const commonContext = {
    client: { hl: "ja", gl: "JP", clientName: "WEB", clientVersion: "2.20251207.11.00" }
  };

  // 1. 動画詳細 (Player API)
  const playerRes = await fetch(YT_PLAYER_API, {
    method: "POST",
    headers,
    body: JSON.stringify({ context: commonContext, videoId })
  });
  const playerData = await playerRes.json();
  const v = playerData.videoDetails;

  if (!v) throw new Error("Video not found");

  // 2. 関連動画 (Next API)
  const nextRes = await fetch(YT_NEXT_API, {
    method: "POST",
    headers,
    body: JSON.stringify({ context: commonContext, videoId })
  });
  const nextData = await nextRes.json();

  // 関連動画のパース
  const results = nextData?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
  
  const relatedVideos = await Promise.all(
    results
      .map(r => r.compactVideoRenderer)
      .filter(Boolean)
      .map(async (rv) => {
        return {
          videoId: rv.videoId,
          title: extractText(rv.title),
          author: extractText(rv.shortBylineText),
          duration: extractText(rv.lengthText),
          viewCount: extractText(rv.viewCountText),
          publishedAt: extractText(rv.publishedTimeText),
          thumbnail: await fetchThumbnailWithFallback(rv.videoId) // 関連動画もBase64化
        };
      })
  );

  return {
    videoId: v.videoId,
    title: v.title,
    author: v.author,
    channelId: v.channelId,
    description: v.shortDescription,
    viewCount: v.viewCount,
    lengthSeconds: v.lengthSeconds,
    thumbnail: await fetchThumbnailWithFallback(videoId),
    related: relatedVideos // 関連動画リストをここに追加
  };
}

// APIルート
app.get("/api/video/:videoid", async (req, res) => {
  try {
    const data = await getVideoWithRelated(req.params.videoid);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
