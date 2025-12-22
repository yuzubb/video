import express from "express";
import fetch from "node-fetch";
import vm from "vm";

const app = express();
const port = 3011;

const YT_API = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false";

// ヘッダー
const headers = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "sec-ch-ua":
    '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Chrome OS"',
  "sec-ch-ua-platform-version": '"16433.48.0"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-full-version": '"142.0.7444.181"',
  "sec-ch-ua-full-version-list":
    '"Chromium";v="142.0.7444.181", "Google Chrome";v="142.0.7444.181", "Not_A Brand";v="99.0.0.0"',
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "x-youtube-client-name": "1",
  "x-youtube-client-version": "2.20251207.11.00",
  Origin: "https://www.youtube.com",
  Referer: "https://www.youtube.com/",
};

// テキスト抽出
function extractTitle(t) {
  if (!t) return null;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join("");
  if (t.text) return t.text;
  return null;
}

async function convertImageToBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("[WARN] Thumbnail fetch failed:", url);
      return null;
    }
    const buf = await res.arrayBuffer();
    const ext = url.endsWith(".jpg") ? "jpg" : "webp";
    return `data:image/${ext};base64,${Buffer.from(buf).toString("base64")}`;
  } catch (err) {
    console.error("[convertImageToBase64] Error:", err);
    return null;
  }
}

async function fetchThumbnailWithFallback(vid) {
  // 高解像度サムネイルを優先
  const maxres = `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`;
  const hq = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  const webp = `https://i.ytimg.com/vi_webp/${vid}/default.webp`;
  const jpg = `https://i.ytimg.com/vi/${vid}/default.jpg`;

  // maxresから試す
  const maxresData = await convertImageToBase64(maxres);
  if (maxresData) return maxresData;

  // hqdefault
  const hqData = await convertImageToBase64(hq);
  if (hqData) return hqData;

  // webp
  const webpData = await convertImageToBase64(webp);
  if (webpData) return webpData;

  // jpg
  const jpgData = await convertImageToBase64(jpg);
  if (jpgData) return jpgData;

  console.warn("[WARN] All thumbnail formats failed for:", vid);
  return null;
}

// ytInitialData 抽出
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
    console.error("[extractInitialData] Error:", err);
    throw err;
  }
}

// 動画情報取得（徹底的に探索）
async function fetchVideoInfo(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const data = await extractInitialData(url);

  console.log("[DEBUG] Searching for video data in ytInitialData...");

  const results = data?.contents?.twoColumnWatchNextResults;
  if (!results) {
    throw new Error("twoColumnWatchNextResults not found");
  }

  // 基本情報の取得
  const resultsContents = results?.results?.results?.contents || [];
  let primaryInfo = null;
  let secondaryInfo = null;

  for (const item of resultsContents) {
    if (item.videoPrimaryInfoRenderer) {
      primaryInfo = item.videoPrimaryInfoRenderer;
    }
    if (item.videoSecondaryInfoRenderer) {
      secondaryInfo = item.videoSecondaryInfoRenderer;
    }
  }

  if (!primaryInfo || !secondaryInfo) {
    console.error("[ERROR] Primary or secondary info not found");
    throw new Error("Video info not found");
  }

  // サムネイル取得
  const thumbnail = await fetchThumbnailWithFallback(videoId);

  // 視聴回数（複数のパターンを試す）
  let viewCountText = null;
  if (primaryInfo?.viewCount?.videoViewCountRenderer?.viewCount) {
    viewCountText = extractTitle(
      primaryInfo.viewCount.videoViewCountRenderer.viewCount
    );
  } else if (primaryInfo?.viewCount?.simpleText) {
    viewCountText = primaryInfo.viewCount.simpleText;
  }

  // 公開日
  const dateText = extractTitle(primaryInfo?.dateText) || null;

  // いいね数（複数のパターンを試す）
  let likeCount = null;
  const topLevelButtons =
    primaryInfo?.videoActions?.menuRenderer?.topLevelButtons || [];

  for (const btn of topLevelButtons) {
    // segmentedLikeDislikeButtonRenderer
    if (btn.segmentedLikeDislikeButtonRenderer) {
      const likeBtn =
        btn.segmentedLikeDislikeButtonRenderer.likeButton?.toggleButtonRenderer;
      if (likeBtn?.defaultText) {
        likeCount = extractTitle(likeBtn.defaultText);
      }
      if (
        !likeCount &&
        likeBtn?.accessibilityData?.accessibilityData?.label
      ) {
        likeCount = likeBtn.accessibilityData.accessibilityData.label;
      }
    }
    // toggleButtonRenderer（別パターン）
    if (btn.toggleButtonRenderer) {
      const label =
        btn.toggleButtonRenderer.defaultText?.accessibility?.accessibilityData
          ?.label;
      if (label && label.includes("いいね")) {
        likeCount = label;
      }
    }
  }

  // チャンネル情報
  const owner = secondaryInfo?.owner?.videoOwnerRenderer;
  const channelName = extractTitle(owner?.title);
  const channelId = owner?.navigationEndpoint?.browseEndpoint?.browseId || null;
  const subscriberCount = extractTitle(owner?.subscriberCountText) || null;

  // 説明文（複数のパターンを試す）
  let description = null;
  if (secondaryInfo?.attributedDescription) {
    description = extractTitle(secondaryInfo.attributedDescription);
  } else if (secondaryInfo?.description) {
    description = extractTitle(secondaryInfo.description);
  }

  // カテゴリ
  let category = null;
  const metadataRows =
    secondaryInfo?.metadataRowContainer?.metadataRowContainerRenderer?.rows ||
    [];
  for (const row of metadataRows) {
    const title = extractTitle(row?.metadataRowRenderer?.title);
    if (title && title.includes("カテゴリ")) {
      category =
        row?.metadataRowRenderer?.contents?.[0]?.runs?.[0]?.text || null;
      break;
    }
  }

  // 関連動画取得（徹底的に探索）
  console.log("[DEBUG] Searching for related videos...");
  const secondaryResults = results?.secondaryResults?.secondaryResults || {};
  const secondaryResultsContents = secondaryResults?.results || [];

  const relatedVideos = [];

  for (const item of secondaryResultsContents) {
    let video = null;

    // 複数のレンダラータイプをチェック
    if (item.compactVideoRenderer) {
      video = item.compactVideoRenderer;
    } else if (item.videoWithContextRenderer) {
      video = item.videoWithContextRenderer;
    } else if (item.gridVideoRenderer) {
      video = item.gridVideoRenderer;
    } else if (item.videoRenderer) {
      video = item.videoRenderer;
    }

    if (!video || !video.videoId) continue;

    const vid = video.videoId;
    const thumb = await fetchThumbnailWithFallback(vid);

    // タイトル
    const relatedTitle =
      extractTitle(video.title) || extractTitle(video.headline);

    // 再生時間
    let duration = null;
    if (video.lengthText) {
      duration = extractTitle(video.lengthText);
    } else if (video.thumbnailOverlays) {
      for (const overlay of video.thumbnailOverlays) {
        if (overlay.thumbnailOverlayTimeStatusRenderer) {
          duration = extractTitle(
            overlay.thumbnailOverlayTimeStatusRenderer.text
          );
          break;
        }
      }
    }

    // 視聴回数
    let views = null;
    if (video.viewCountText) {
      views = extractTitle(video.viewCountText);
    } else if (video.shortViewCountText) {
      views = extractTitle(video.shortViewCountText);
    }

    // 公開日
    const publishedDate = extractTitle(video.publishedTimeText) || null;

    // チャンネル情報
    const channelInfo =
      video.longBylineText || video.shortBylineText || video.ownerText;
    const relatedChannelName = extractTitle(channelInfo);
    const relatedChannelId =
      channelInfo?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
      video.channelId ||
      null;

    relatedVideos.push({
      videoId: vid,
      title: relatedTitle,
      thumbnail: thumb,
      duration,
      views,
      publishedDate,
      channel: {
        name: relatedChannelName,
        channelId: relatedChannelId,
      },
    });

    // 最大20件まで
    if (relatedVideos.length >= 20) break;
  }

  console.log(`[DEBUG] Found ${relatedVideos.length} related videos`);

  // エンゲージメントパネルから追加情報を取得
  const engagementPanels = data?.engagementPanels || [];
  console.log(
    `[DEBUG] Found ${engagementPanels.length} engagement panels`
  );

  return {
    videoId,
    title: extractTitle(primaryInfo?.title),
    thumbnail,
    views: viewCountText,
    publishedDate: dateText,
    likes: likeCount,
    channel: {
      name: channelName,
      channelId,
      subscribers: subscriberCount,
    },
    description,
    category,
    url,
    relatedVideos,
  };
}

// token
function getTokenFromAppendAction(json) {
  try {
    const items =
      json?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction
        ?.continuationItems || [];
    for (const it of items) {
      const token =
        it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand
          ?.token;
      if (token) return token;
    }
  } catch {}
  return "";
}

function getTokenFromVideoList(items) {
  if (!Array.isArray(items)) return "";
  for (const it of items) {
    const cmds =
      it?.continuationItemRenderer?.continuationEndpoint?.commandExecutorCommand
        ?.commands;
    if (!Array.isArray(cmds)) continue;
    for (const c of cmds) {
      const t = c?.continuationCommand?.token;
      if (t) return t;
    }
  }
  return "";
}

// RD プレイリスト
async function handleRDPlaylist(listId, videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&list=${listId}`;
  const data = await extractInitialData(url);

  const playlist =
    data.contents?.twoColumnWatchNextResults?.playlist?.playlist || null;
  if (!playlist) throw new Error("RD playlist not found");

  const rawItems = playlist.contents || [];
  const items = (
    await Promise.all(
      rawItems.map(async (entry) => {
        const v = entry.playlistPanelVideoRenderer;
        if (!v) return null;
        const vid = v.videoId;

        // サムネ取得
        const thumbnail = await fetchThumbnailWithFallback(vid);

        return {
          videoId: vid,
          title: extractTitle(v.title),
          duration: v.lengthText?.simpleText || null,
          author: extractTitle(v.longBylineText) || "YouTube",
          channelId: null,
          views: null,
          published: null,
          thumbnail,
        };
      })
    )
  ).filter(Boolean);

  const title = extractTitle(playlist.title) || "ミックスリスト";
  const descRaw =
    playlist.description?.simpleText ||
    (Array.isArray(playlist.description?.runs)
      ? playlist.description.runs.map((r) => r.text).join("")
      : null);

  return {
    playlistId: listId,
    title,
    author: "YouTube",
    description:
      descRaw || "Mixes are playlists automatically created by YouTube",
    totalItems: `${items.length} 本`,
    views: null,
    url,
    thumbnail: null,
    lastUpdated: null,
    items,
    nextToken: null,
  };
}

// 通常プレイリスト
async function handleNormalPlaylist(listId, token) {
  const body = {
    context: {
      client: {
        hl: "ja",
        gl: "JP",
        clientName: "WEB",
        clientVersion: "2.20251207.11.00",
        originalUrl: `https://www.youtube.com/playlist?list=${listId}`,
      },
    },
  };

  if (token) body.continuation = token;
  else body.browseId = "VL" + listId;

  const response = await fetch(YT_API, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();

  const meta = json?.metadata?.playlistMetadataRenderer || {};
  const sidebar = json?.sidebar?.playlistSidebarRenderer?.items || [];
  const primary = sidebar[0]?.playlistSidebarPrimaryInfoRenderer;
  const secondary = sidebar[1]?.playlistSidebarSecondaryInfoRenderer;

  const firstPageItems =
    json?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
      ?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer
      ?.contents?.[0]?.playlistVideoListRenderer?.contents || [];

  const extractVideo = async (arr) =>
    (
      await Promise.all(
        arr
          .map((v) => v.playlistVideoRenderer)
          .filter(Boolean)
          .map(async (v) => {
            const vid = v.videoId;

            // サムネ取得
            const thumbnail = await fetchThumbnailWithFallback(vid);

            return {
              videoId: vid,
              title: v.title?.runs?.[0]?.text || "",
              duration:
                v.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer
                  ?.text?.simpleText || "",
              channelId:
                v.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint
                  ?.browseId || "",
              author: v.shortBylineText?.runs?.[0]?.text || "",
              views: v.videoInfo?.runs?.[0]?.text || "",
              published: v.videoInfo?.runs?.[2]?.text || "",
              thumbnail,
            };
          })
      )
    ).filter(Boolean);

  const firstVideos = await extractVideo(firstPageItems);

  const continuationItems =
    json?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction
      ?.continuationItems || [];
  const continuationVideos = await extractVideo(continuationItems);

  const items = [...firstVideos, ...continuationVideos];

  const nextToken =
    getTokenFromAppendAction(json) || getTokenFromVideoList(firstPageItems) || "";

  return {
    playlistId: listId,
    title: meta.title || "",
    author:
      secondary?.videoOwner?.videoOwnerRenderer?.title?.runs?.[0]?.text || "",
    description: meta.description || "",
    responseItems: `${items.length}`,
    totalItems: (primary?.stats?.[0]?.runs?.[0]?.text || "") + "本",
    url: `https://www.youtube.com/playlist?list=${listId}`,
    lastUpdated: primary?.stats?.[2]?.runs?.[1]?.text || "",
    items,
    nextToken,
  };
}

// 動画情報取得エンドポイント
app.get("/api/video/:videoid", async (req, res) => {
  const videoId = req.params.videoid;

  try {
    const videoInfo = await fetchVideoInfo(videoId);
    return res.json(videoInfo);
  } catch (err) {
    console.error("[/api/video] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// プレイリスト取得エンドポイント
app.get("/playlist/:id", async (req, res) => {
  const listId = req.params.id;
  const videoId = req.query.v || null;
  const token = req.query.token || null;

  try {
    if (listId.startsWith("RD")) {
      if (!videoId)
        throw new Error("RD プレイリストには v パラメータが必要です");
      const json = await handleRDPlaylist(listId, videoId);
      return res.json(json);
    }

    const json = await handleNormalPlaylist(listId, token);
    return res.json(json);
  } catch (err) {
    console.error("[/playlist] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
