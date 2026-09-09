"use client";

/**
 * Daily quote (每日金句) for the Home header line.
 *
 * Pulls inspirational one-liners from several free, key-less, CORS-open
 * Chinese quote APIs. Sources are walked in order — a dead or timed-out
 * source falls through to the next — and every source that answers
 * contributes to a small rotating pool. When nothing answers (offline),
 * a bundled curated pool keeps the line alive. The UI rotates the visible
 * quote every QUOTE_ROTATE_MS.
 */

import { useQuery } from "@tanstack/react-query";

export interface DailyQuote {
  text: string;
  /** Author / origin, rendered after the text when present. */
  source?: string;
}

/** How often the visible quote rotates. */
export const QUOTE_ROTATE_MS = 10_000;
/** How often the quote pool refetches from the providers. */
const POOL_REFRESH_MS = 5 * 60_000;
/** Per-source timeout before falling through to the next provider. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Stop walking the provider list once the pool holds this many quotes. */
const MIN_POOL_FROM_PROVIDERS = 3;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * hitokoto 一言 — categories 文学/原创/网络/哲学, the closest to 励志 copy.
 * Main site first, international mirror second: same dataset on independent
 * edges, so one being slow or down doesn't take the line down.
 */
async function fetchFromHitokoto(host: string): Promise<DailyQuote[]> {
  const data = await fetchJson(`${host}/?c=d&c=e&c=f&c=k&encode=json`);
  if (!isRecord(data) || typeof data.hitokoto !== "string" || !data.hitokoto) return [];
  const who = typeof data.from_who === "string" && data.from_who ? data.from_who : null;
  const from = typeof data.from === "string" && data.from !== data.from_who ? data.from : null;
  return [
    {
      text: data.hitokoto,
      source: who && from ? `${who}《${from}》` : (who ?? (from ? `《${from}》` : undefined)),
    },
  ];
}

/** jinrishici 今日诗词 — classical poetry as a third opinion. */
async function fetchFromJinrishici(): Promise<DailyQuote[]> {
  const data = await fetchJson("https://v1.jinrishici.com/all");
  if (!isRecord(data) || typeof data.content !== "string" || !data.content) return [];
  const author = typeof data.author === "string" && data.author ? data.author : null;
  const origin = typeof data.origin === "string" && data.origin ? data.origin : null;
  return [
    {
      text: data.content,
      source: author && origin ? `${author}《${origin}》` : (author ?? undefined),
    },
  ];
}

const PROVIDERS: Array<() => Promise<DailyQuote[]>> = [
  () => fetchFromHitokoto("https://v1.hitokoto.cn"),
  () => fetchFromHitokoto("https://international.v1.hitokoto.cn"),
  fetchFromJinrishici,
];

/**
 * Walk the providers in order, collecting from every one that answers and
 * stopping early once the pool is big enough. All fail → empty array; the
 * bundled fallback pool takes over.
 */
async function fetchQuotePool(): Promise<DailyQuote[]> {
  const pool: DailyQuote[] = [];
  for (const provider of PROVIDERS) {
    try {
      const quotes = await provider();
      pool.push(...quotes.filter((q) => q.text));
    } catch {
      // Dead or timed-out source — the next one takes over.
    }
    if (pool.length >= MIN_POOL_FROM_PROVIDERS) break;
  }
  return pool;
}

/** Curated 励志 quotes shown when no provider answers (or to pad the pool). */
const FALLBACK_QUOTES: DailyQuote[] = [
  { text: "长风破浪会有时，直挂云帆济沧海", source: "李白《行路难》" },
  { text: "天生我材必有用，千金散尽还复来", source: "李白《将进酒》" },
  { text: "大鹏一日同风起，扶摇直上九万里", source: "李白《上李邕》" },
  { text: "会当凌绝顶，一览众山小", source: "杜甫《望岳》" },
  { text: "欲穷千里目，更上一层楼", source: "王之涣《登鹳雀楼》" },
  { text: "千磨万击还坚劲，任尔东西南北风", source: "郑燮《竹石》" },
  { text: "不经一番寒彻骨，怎得梅花扑鼻香", source: "黄檗禅师《上堂开示颂》" },
  { text: "宝剑锋从磨砺出，梅花香自苦寒来", source: "《警世贤文》" },
  { text: "路漫漫其修远兮，吾将上下而求索", source: "屈原《离骚》" },
  { text: "天行健，君子以自强不息", source: "《周易》" },
  { text: "老骥伏枥，志在千里", source: "曹操《龟虽寿》" },
  { text: "少壮不努力，老大徒伤悲", source: "《长歌行》" },
  { text: "业精于勤，荒于嬉", source: "韩愈《进学解》" },
  { text: "千里之行，始于足下", source: "《老子》" },
  { text: "锲而不舍，金石可镂", source: "《荀子·劝学》" },
  { text: "有志者事竟成", source: "《后汉书》" },
  { text: "精诚所至，金石为开", source: "《后汉书》" },
  { text: "绳锯木断，水滴石穿", source: "罗大经《鹤林玉露》" },
  { text: "穷且益坚，不坠青云之志", source: "王勃《滕王阁序》" },
  { text: "沉舟侧畔千帆过，病树前头万木春", source: "刘禹锡《酬乐天扬州初逢席上见赠》" },
  { text: "千淘万漉虽辛苦，吹尽狂沙始到金", source: "刘禹锡《浪淘沙》" },
  { text: "山重水复疑无路，柳暗花明又一村", source: "陆游《游山西村》" },
  { text: "博观而约取，厚积而薄发", source: "苏轼《稼说送张琥》" },
  { text: "古之立大事者，不惟有超世之才，亦必有坚忍不拔之志", source: "苏轼《晁错论》" },
  { text: "士不可以不弘毅，任重而道远", source: "《论语·泰伯》" },
  { text: "三军可夺帅也，匹夫不可夺志也", source: "《论语·子罕》" },
  { text: "志当存高远", source: "诸葛亮《诫外甥书》" },
  { text: "非淡泊无以明志，非宁静无以致远", source: "诸葛亮《诫子书》" },
  { text: "少年易老学难成，一寸光阴不可轻", source: "朱熹《偶成》" },
  { text: "明日复明日，明日何其多", source: "钱福《明日歌》" },
  { text: "操千曲而后晓声，观千剑而后识器", source: "刘勰《文心雕龙》" },
];

/**
 * The rotating quote pool: fresh provider quotes first, curated fallback
 * entries padding the tail so the carousel always has something to show.
 */
export function useDailyQuotes(): DailyQuote[] {
  const query = useQuery({
    queryKey: ["daily-quotes"],
    queryFn: fetchQuotePool,
    staleTime: POOL_REFRESH_MS,
    refetchInterval: POOL_REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  const fetched = query.data ?? [];
  return fetched.length > 0 ? [...fetched, ...FALLBACK_QUOTES] : FALLBACK_QUOTES;
}
