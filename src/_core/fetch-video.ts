/* eslint-disable no-await-in-loop */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import log4js from 'log4js';
import sleep from 'sleep-promise';

const logger = log4js.getLogger('fetch-video');
logger.level = log4js.levels.INFO;

const YOUTUBE_SEARCH_URL = 'https://www.youtube.com/results';
const NICOVIDEO_SEARCH_URL = 'https://www.nicovideo.jp/search';
const NICOVIDEO_THUMBINFO_URL = 'https://ext.nicovideo.jp/api/getthumbinfo';

function parseYouTubeViewCount(raw: string | null | undefined) {
  if (!raw) return null;
  // common formats: "1,234,567 views" / "1.2M views" / "1.2万 回視聴" etc.
  const value = raw.trim().replace(/\s/g, '');

  // Try to find a number with optional suffix
  const match = value.match(/([\d,.]+)([KkMm万億]*)/);
  if (!match) return null;

  let num = Number(match[1].replace(/,/g, ''));
  const suffix = match[2];
  if (Number.isNaN(num)) return null;

  if (suffix) {
    if (suffix.toLowerCase() === 'k') num *= 1_000;
    if (suffix.toLowerCase() === 'm') num *= 1_000_000;
    if (suffix === '万') num *= 10_000;
    if (suffix === '億') num *= 100_000_000;
  }

  return Math.round(num);
}

function parseNicoViewCount(xml: string) {
  const match = xml.match(/<view_counter>(\d+)<\/view_counter>/);
  return match ? Number(match[1]) : null;
}

async function searchYouTubeVideo(query: string) {
  const url = new URL(YOUTUBE_SEARCH_URL);
  url.searchParams.set('search_query', query);

  const res = await axios.get(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 60000,
  });

  const $ = cheerio.load(res.data);

  // Try to get first search result from rendered HTML.
  const item = $('ytd-video-renderer,ytd-grid-video-renderer').first();
  if (item.length === 0) {
    // Fallback: attempt to parse ytInitialData JSON
    const script = $('script').filter((_, el) => $(el).html()?.includes('ytInitialData')).first();
    const jsonText = script.html()?.match(/ytInitialData\s*=\s*(\{.*\});/s)?.[1];
    if (jsonText) {
      try {
        const data = JSON.parse(jsonText);
        const videoRenderer = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.videoRenderer;
        const videoId = videoRenderer?.videoId;
        const viewText = videoRenderer?.viewCountText?.simpleText ?? videoRenderer?.viewCountText?.runs?.[0]?.text;
        if (!videoId) return null;
        return {
          id: videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          viewCount: parseYouTubeViewCount(viewText),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  const titleLink = item.find('a#video-title');
  const href = titleLink.attr('href') ?? titleLink.prop('href');
  const metadataLine = item.find('#metadata-line');
  const countText = metadataLine.find('span').first().text().trim() || null;

  if (!href) return null;
  const videoIdMatch = href.match(/[?&]v=([^&]+)/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  if (!videoId) return null;

  return {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    viewCount: parseYouTubeViewCount(countText),
  };
}

async function searchNicoVideo(query: string) {
  const url = new URL(NICOVIDEO_SEARCH_URL);
  url.searchParams.set('sort', 'viewCounter');
  url.searchParams.set('q', query);

  const res = await axios.get(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    timeout: 60000,
  });

  const $ = cheerio.load(res.data);
  const item = $('article .item').first();
  if (!item.length) return null;

  const href = item.find('a').attr('href');
  if (!href) return null;

  const idMatch = href.match(/(?:watch\/|v=)(sm\d+|nm\d+)/);
  const id = idMatch ? idMatch[1] : null;
  if (!id) return null;

  const thumbInfoUrl = `${NICOVIDEO_THUMBINFO_URL}/${id}`;
  const thumbRes = await axios.get(thumbInfoUrl, { timeout: 60000 });
  const viewCount = parseNicoViewCount(thumbRes.data);

  return {
    id,
    url: `https://www.nicovideo.jp/watch/${id}`,
    viewCount,
  };
}

export default async function run(gameCode: string) {
  if (!gameCode) throw new Error('Game code is required.');

  const distDir = path.join('dist', gameCode);
  const dataPath = path.join(distDir, 'data.json');
  const videoPath = path.join(distDir, 'video.json');

  if (!fs.existsSync(dataPath)) {
    throw new Error(`${dataPath} not found. Run "npm run ${gameCode}:gen-json" first.`);
  }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as any;

  const existing = fs.existsSync(videoPath)
    ? (JSON.parse(fs.readFileSync(videoPath, 'utf-8')) as any)
    : { updateTime: null, videos: {} };

  for (const song of data.songs) {
    const songId = song.songId;
    if (!songId) continue;

    const existingEntry = existing.videos?.[songId];
    if (existingEntry?.youtube?.id && existingEntry?.youtube?.viewCount != null) {
      logger.info(`${songId}: YouTube data already present, skipping.`);
      continue;
    }

    const query = [gameCode, song.title, song.artist].filter(Boolean).join(' ');

    logger.info(`${songId}: searching YouTube for "${query}" ...`);
    const youtube = await searchYouTubeVideo(query);
    if (youtube) {
      existing.videos = existing.videos || {};
      existing.videos[songId] = {
        ...existing.videos[songId],
        youtube: {
          ...existing.videos[songId]?.youtube,
          ...youtube,
          updatedAt: new Date().toISOString(),
        },
      };
      logger.info(`  found YouTube:${youtube.id} (${youtube.viewCount ?? '?'} views)`);
    }

    logger.info(`${songId}: searching NicoNico for "${query}" ...`);
    const nico = await searchNicoVideo(query);
    if (nico) {
      existing.videos = existing.videos || {};
      existing.videos[songId] = {
        ...existing.videos[songId],
        niconico: {
          ...existing.videos[songId]?.niconico,
          ...nico,
          updatedAt: new Date().toISOString(),
        },
      };
      logger.info(`  found Nico:${nico.id} (${nico.viewCount ?? '?'} views)`);
    }

    // throttle
    await sleep(1000 + Math.random() * 1000);
  }

  const output = {
    updateTime: new Date().toISOString(),
    videos: existing.videos,
  };
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(videoPath, JSON.stringify(output, null, '\t'));

  logger.info(`Wrote ${videoPath}`);
}

if (require.main === module) run(process.argv[2]);
