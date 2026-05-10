/*
 * AllAnime source for Luna / Sora
 * Patched version - defensive parsing, fallbacks, and better logging.
 *
 * Compatible with module manifest flags:
 *   "asyncJS": true,
 *   "streamAsyncJS": true
 */

const apiUrl  = "https://api.allanime.day/api";
const baseUrl = "https://allmanga.to";

// AllAnime API rejects requests without a browser-like UA / Referer.
const DEFAULT_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer":      baseUrl + "/",
    "Origin":       baseUrl
};

/* ------------------------------------------------------------------ */
/*  GRAPHQL QUERIES                                                   */
/* ------------------------------------------------------------------ */
const SEARCH_QUERY = `
query(
  $search: SearchInput,
  $limit: Int,
  $countryOrigin: VaildCountryOriginEnumType,
  $page: Int
) {
  shows(
    search: $search,
    limit: $limit,
    countryOrigin: $countryOrigin,
    page: $page
  ) {
    edges {
      _id
      name
      nativeName
      englishName
      thumbnail
      slugTime
    }
  }
}`;

const DETAIL_EPISODE_QUERY = `
query($id: String!) {
  show(_id: $id) {
    name
    englishName
    nativeName
    thumbnail
    description
    type
    season
    score
    genres
    status
    studios
    availableEpisodesDetail
  }
}`;

const STREAM_QUERY = `
query(
  $showId: String!,
  $episodeString: String!,
  $translationType: VaildTranslationTypeEnumType!
) {
  episode(
    showId: $showId,
    episodeString: $episodeString,
    translationType: $translationType
  ) {
    sourceUrls
  }
}`;

/* ------------------------------------------------------------------ */
/*  SMALL HELPERS                                                     */
/* ------------------------------------------------------------------ */
function logErr(tag, e) {
    try { console.log(`[AllAnime][${tag}] ${e && e.message ? e.message : e}`); } catch (_) {}
}

function logDbg(tag, msg) {
    try { console.log(`[AllAnime][${tag}] ${msg}`); } catch (_) {}
}

// Safely parse JSON; on failure log the raw body so we can diagnose.
async function safeJson(response, tag) {
    const raw = await response.text();
    try {
        return JSON.parse(raw);
    } catch (e) {
        logErr(tag, "JSON parse failed. Raw body (first 500 chars): " +
                    (raw || "").slice(0, 500));
        throw e;
    }
}

async function gql(query, variables, tag) {
    const body = { query: query.replace(/\n/g, " "), variables: variables };
    const res  = await fetchv2(apiUrl, DEFAULT_HEADERS, "POST", body);
    if (!res) throw new Error("Empty response from " + apiUrl);
    return await safeJson(res, tag);
}

// Episode/stream queries are now blocked by Cloudflare/captcha on POST.
// We have to use GET + a persisted-query hash + youtu-chan.com headers,
// then AES-256-CTR decrypt the "tobeparsed" blob (key/hash from ani-cli).
const EPISODE_PERSIST_HASH = "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec";
const ANIME_AES_KEY = [
    0xa2,0x54,0xaa,0x27,0xc4,0x10,0xf2,0x97,0xbd,0x04,0xba,0x33,0xa0,0xc0,0xdf,0x7f,
    0xf4,0xe7,0x06,0xbf,0x3a,0xe2,0x72,0x71,0xc6,0x70,0x3f,0x84,0xe7,0x50,0xf5,0x52
]; // sha256("Xot36i3lK3:v1")

async function fetchEpisodeSources(variables, tag) {
    const ext = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: EPISODE_PERSIST_HASH } });
    const url = apiUrl
        + "?variables=" + encodeURIComponent(JSON.stringify(variables))
        + "&extensions=" + encodeURIComponent(ext);

    const headers = {
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        "Referer":    "https://youtu-chan.com",
        "Origin":     "https://youtu-chan.com"
    };

    const res  = await fetchv2(url, headers, "GET");
    if (!res) throw new Error("Empty response from episode endpoint");
    const data = await safeJson(res, tag);

    if (data && data.data && data.data.tobeparsed) {
        try {
            const plain = aesCtrDecryptBlob(data.data.tobeparsed, ANIME_AES_KEY);
            return parseTobeparsed(plain);
        } catch (e) {
            logErr(tag + "-decrypt", e);
            return [];
        }
    }
    if (data && data.errors) {
        logErr(tag, "GraphQL errors: " + JSON.stringify(data.errors).slice(0, 300));
    }
    return [];
}

// The decrypted blob is full JSON. Pull out episode.sourceUrls.
function parseTobeparsed(plain) {
    try {
        const j = JSON.parse(plain);
        const arr = j && j.episode && j.episode.sourceUrls;
        if (Array.isArray(arr)) {
            return arr.map(x => ({
                sourceUrl:  x.sourceUrl  || "",
                sourceName: x.sourceName || "",
                priority:   typeof x.priority === "number" ? x.priority : 0,
                type:       x.type || ""
            }));
        }
    } catch (e) { /* fall through to regex */ }

    const out = [];
    const re = /"sourceUrl":"([^"]+)"[^}]*?"sourceName":"([^"]+)"/g;
    let m;
    while ((m = re.exec(plain)) !== null) {
        out.push({ sourceUrl: m[1], sourceName: m[2] });
    }
    return out;
}

function pickTitle(obj) {
    if (!obj) return "Unknown";
    return obj.englishName || obj.name || obj.nativeName || "Unknown";
}

// AllAnime returns relative thumbnail paths like "mcovers/a_tbs/dhw/xxx.webp".
// Prepend the image CDN so Sora can load them.
function fixImage(url) {
    if (!url) return "https://allmanga.to/favicon.ico";
    if (/^https?:\/\//i.test(url)) return url;
    return "https://wp.youtube-anime.com/aln.youtube-anime.com/" + url.replace(/^\/+/, "");
}

/* ------------------------------------------------------------------ */
/*  SEARCH                                                            */
/* ------------------------------------------------------------------ */
async function searchResults(keyword) {
    try {
        const variables = {
            search: { query: keyword, allowAdult: false, allowUnknown: false },
            countryOrigin: "ALL",
            limit: 26,
            page: 1
        };

        const data = await gql(SEARCH_QUERY, variables, "search");
        const edges = (data && data.data && data.data.shows && data.data.shows.edges) || [];

        if (!edges.length) {
            logDbg("search", "No results for '" + keyword + "'");
            return JSON.stringify([]);
        }

        const results = edges.map(a => ({
            title: pickTitle(a),
            image: fixImage(a && a.thumbnail),
            href:  a && a._id ? a._id : ""
        })).filter(r => r.href);

        return JSON.stringify(results);
    } catch (error) {
        logErr("search", error);
        return JSON.stringify([]);
    }
}

/* ------------------------------------------------------------------ */
/*  DETAILS                                                           */
/* ------------------------------------------------------------------ */
async function extractDetails(id) {
    try {
        const data  = await gql(DETAIL_EPISODE_QUERY, { id: id }, "details");
        const anime = data && data.data && data.data.show;

        if (!anime) {
            logErr("details", "show object missing");
            throw new Error("missing show");
        }

        const desc = anime.description
            ? htmlToText(anime.description).replace(/\n/g, "").replace(/\s+/g, " ")
            : "No description available";

        const year = (anime.season && anime.season.year) ? anime.season.year : "Unknown";

        const genres = Array.isArray(anime.genres) && anime.genres.length
            ? anime.genres.join(", ")
            : "Unknown";

        return JSON.stringify([{
            description: desc,
            aliases:     `Genres: ${genres}`,
            airdate:     `Aired: ${year}`
        }]);
    } catch (error) {
        logErr("details", error);
        return JSON.stringify([{
            description: "Error loading description",
            aliases:     "Genres: Unknown",
            airdate:     "Aired: Unknown"
        }]);
    }
}

/* ------------------------------------------------------------------ */
/*  EPISODES                                                          */
/* ------------------------------------------------------------------ */
async function extractEpisodes(id) {
    try {
        const data  = await gql(DETAIL_EPISODE_QUERY, { id: id }, "episodes");
        const anime = data && data.data && data.data.show;

        if (!anime) {
            logErr("episodes", "show object missing");
            return JSON.stringify([]);
        }

        const detail = anime.availableEpisodesDetail || {};
        // Prefer sub, fall back to dub or raw if sub missing.
        const list = (Array.isArray(detail.sub) && detail.sub.length) ? detail.sub
                  : (Array.isArray(detail.dub) && detail.dub.length) ? detail.dub
                  : (Array.isArray(detail.raw) && detail.raw.length) ? detail.raw
                  : [];

        if (!list.length) {
            logDbg("episodes", "No episodes for " + id);
            return JSON.stringify([]);
        }

        const translationType = (Array.isArray(detail.sub) && detail.sub.length) ? "sub"
                              : (Array.isArray(detail.dub) && detail.dub.length) ? "dub"
                              : "raw";

        const results = list.map(ep => ({
            href: JSON.stringify({
                showId: id,
                translationType: translationType,
                episodeString: String(ep)
            }),
            number: parseFloat(ep) || 1
        }));

        // AllAnime returns episodes high->low; reverse so 1 first.
        results.sort((a, b) => a.number - b.number);
        return JSON.stringify(results);
    } catch (error) {
        logErr("episodes", error);
        return JSON.stringify([]);
    }
}

/* ------------------------------------------------------------------ */
/*  STREAM                                                            */
/* ------------------------------------------------------------------ */
async function extractStreamUrl(url) {
    try {
        let subArr = [];
        let dubArr = [];

        try { subArr = await exctractSubOrDubURLs(url, "sub"); }
        catch (e) { logErr("stream-sub", e); }

        try { dubArr = await exctractSubOrDubURLs(url, "dub"); }
        catch (e) { logErr("stream-dub", e); }

        const streams = [].concat(subArr || [], dubArr || []);

        if (!streams.length) {
            logDbg("stream", "No streams found for " + url);
        }

        // Luna / Sora expects: { streams: [label1, url1, label2, url2, ...], subtitles: [] }
        return JSON.stringify({ streams: streams, subtitles: [] });
    } catch (error) {
        logErr("stream", error);
        return JSON.stringify({ streams: [], subtitles: [] });
    }
}

async function exctractSubOrDubURLs(url, type) {
    let variable;
    try {
        variable = (typeof url === "string") ? JSON.parse(url) : url;
    } catch (e) {
        logErr("stream-parse", "Bad href payload: " + url);
        return [];
    }
    variable.translationType = type;
    variable.episodeString   = String(variable.episodeString);

    const sources = await fetchEpisodeSources(variable, "stream-" + type);
    if (!sources.length) {
        logDbg("stream-" + type, "no sourceUrls");
        return [];
    }

    const pick = name => sources.filter(x => x && x.sourceName === name);

    const sMp4Val     = pick("S-mp4");        // XOR-encoded, points to allanime apivtwo
    const lufMp4Val   = pick("Luf-Mp4");      // XOR-encoded
    const ytMp4Val    = pick("Yt-mp4");       // XOR-encoded
    const mp4Val      = pick("Mp4");          // direct mp4upload iframe
    const okVal       = pick("Ok");
    const swVal       = pick("Sw");
    const fileMoonVal = pick("Fm-Hls");

    const streams = [];

    // Filemoon
    try {
        if (fileMoonVal.length) {
            const u = await filemoonExtractor(fileMoonVal[0].sourceUrl);
            if (u) streams.push(`FileMoon ${type}`, u);
        }
    } catch (e) { logErr("filemoon", e); }

    // StreamWish
    try {
        if (swVal.length) {
            const u = await streamWishExtractor(swVal[0].sourceUrl);
            if (u) streams.push(`StreamWish ${type}`, u);
        }
    } catch (e) { logErr("streamwish", e); }

    // OK.ru
    try {
        if (okVal.length) {
            const u = await okruExtractor(okVal[0].sourceUrl);
            if (u) streams.push(`Okru ${type}`, u);
        }
    } catch (e) { logErr("okru", e); }

    // mp4upload
    try {
        if (mp4Val.length) {
            const u = await mp4Extractor(mp4Val[0].sourceUrl);
            if (u) streams.push(`Mp4Upload ${type}`, u);
        }
    } catch (e) { logErr("mp4", e); }

    // S-mp4 / Luf-Mp4 / Yt-mp4 — XOR-encoded paths to allanime's clock endpoint.
    const xorSources = [
        { label: "S-mp4",   list: sMp4Val   },
        { label: "Luf-Mp4", list: lufMp4Val },
        { label: "Yt-mp4",  list: ytMp4Val  }
    ];
    for (const src of xorSources) {
        try {
            if (src.list.length) {
                const dec = decryptSource(src.list[0].sourceUrl);
                if (dec) {
                    const u = await defaultExtractor(dec.replace("/clock?", "/clock.json?"));
                    if (u) streams.push(`${src.label} ${type}`, u);
                }
            }
        } catch (e) { logErr(src.label, e); }
    }

    return streams;
}

/* ------------------------------------------------------------------ */
/*  SOURCE URL DECRYPTION                                             */
/* ------------------------------------------------------------------ */
function decryptSource(str) {
    if (!str) return "";
    if (str.startsWith("-")) {
        return str.substring(str.lastIndexOf("-") + 1)
            .match(/.{1,2}/g)
            .map(hex => parseInt(hex, 16))
            .map(byte => String.fromCharCode(byte ^ 56))
            .join("");
    }
    return str;
}

/* ------------------------------------------------------------------ */
/*  HTML / TEXT UTIL                                                  */
/* ------------------------------------------------------------------ */
function htmlToText(htmlText) {
    if (!htmlText) return "";
    let text = htmlText.replace(/<br\s*\/?>/gi, "\n");
    const entities = {
        "&amp;": "&", "&lt;": "<", "&gt;": ">",
        "&quot;": '"', "&apos;": "'",
        "&#x2014;": "—", "&#x2019;": "’",
        "&#x201c;": "“", "&#x201d;": "”"
    };
    text = text.replace(/&#x[0-9a-fA-F]+;|&[a-z]+;/g, m => {
        if (entities[m]) return entities[m];
        if (/^&#x/.test(m)) {
            const code = parseInt(m.replace(/[&#x;]/g, ""), 16);
            return String.fromCharCode(code);
        }
        return m;
    });
    text = text.replace(/<[^>]*>/g, "");
    return text;
}

/* ------------------------------------------------------------------ */
/*  EXTRACTORS                                                        */
/* ------------------------------------------------------------------ */
function extractFileMoonScript(html) {
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (m[1].includes("eval") && m[1].includes("m3u8")) return m[1];
    }
    return null;
}

function extractIframeSrc(html) {
    const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    return m ? m[1] : null;
}

async function filemoonExtractor(streamUrl) {
    try {
        const res  = await fetchv2(streamUrl);
        const text = await res.text();
        let script = extractFileMoonScript(text);

        if (!script) {
            const iframe = extractIframeSrc(text);
            if (!iframe) return null;
            const r2 = await fetchv2(iframe);
            const t2 = await r2.text();
            script   = extractFileMoonScript(t2);
        }
        if (!script) return null;

        const unpacked = unpack(script);
        const m = unpacked.match(/https?:\/\/[^\s"']+master\.m3u8[^\s"']*/);
        return m ? m[0] : null;
    } catch (e) {
        logErr("filemoon", e);
        return null;
    }
}

async function streamWishExtractor(url) {
    try {
        const res  = await fetchv2(url);
        const text = await res.text();
        const unpacked = unpack(text);
        const m = unpacked.match(/https?:\/\/[^\s"']+master\.m3u8[^\s"']*/);
        return m ? m[0] : null;
    } catch (e) {
        logErr("streamwish", e);
        return null;
    }
}

async function defaultExtractor(url) {
    try {
        const res  = await fetchv2(`${baseUrl}/getVersion`);
        const ver  = await res.json();
        const ep   = ver && ver.episodeIframeHead;
        if (!ep) return null;
        const r2   = await fetchv2(ep + url, { "Referer": baseUrl });
        const data = await r2.json();
        if (data && data.links && data.links.length && data.links[0].link) {
            return data.links[0].link;
        }
        return null;
    } catch (e) {
        logErr("default", e);
        return null;
    }
}

async function okruExtractor(url) {
    try {
        const res = await fetchv2(url, {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
        });
        const body = await res.text();
        const m = body.match(/data-options="([^"]*)"/);
        if (!m) return null;
        const json = JSON.parse(m[1].replace(/&quot;/g, '"'));
        const meta = JSON.parse(json.flashvars.metadata);
        return meta.hlsManifestUrl || meta.ondemandHls || null;
    } catch (e) {
        logErr("okru", e);
        return null;
    }
}

async function mp4Extractor(url) {
    try {
        const res = await fetchv2(url, { "Referer": "https://mp4upload.com" });
        const html = await res.text();
        return extractMp4Script(html);
    } catch (e) {
        logErr("mp4", e);
        return null;
    }
}

function extractMp4Script(htmlText) {
    const scripts = extractScriptTags(htmlText);
    let script = scripts.find(s => s.includes("player.src")) ||
                 scripts.find(s => s.includes("eval"));
    if (!script) return null;
    try {
        return script.split(".src(")[1].split(")")[0]
                     .split("src:")[1].split('"')[1] || null;
    } catch (_) { return null; }
}

function extractScriptTags(html) {
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    const out = [];
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1].trim());
    return out;
}

/* ------------------------------------------------------------------ */
/*  P.A.C.K.E.R DEOBFUSCATOR                                          */
/* ------------------------------------------------------------------ */
class Unbaser {
    constructor(base) {
        this.ALPHABET = {
            62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            95: "' !\"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'"
        };
        this.dictionary = {};
        this.base = base;
        if (36 < base && base < 62) {
            this.ALPHABET[base] = this.ALPHABET[base] || this.ALPHABET[62].substr(0, base);
        }
        if (2 <= base && base <= 36) {
            this.unbase = v => parseInt(v, base);
        } else {
            try {
                [...this.ALPHABET[base]].forEach((c, i) => { this.dictionary[c] = i; });
            } catch (e) { throw Error("Unsupported base encoding."); }
            this.unbase = this._dictunbaser;
        }
    }
    _dictunbaser(value) {
        let ret = 0;
        [...value].reverse().forEach((c, i) => {
            ret += Math.pow(this.base, i) * this.dictionary[c];
        });
        return ret;
    }
}

function unpack(source) {
    const { payload, symtab, radix, count } = _filterargs(source);
    if (count != symtab.length) throw Error("Malformed p.a.c.k.e.r. symtab.");
    let unbase;
    try { unbase = new Unbaser(radix); }
    catch (e) { throw Error("Unknown p.a.c.k.e.r. encoding."); }
    function lookup(match) {
        const word = match;
        const w2 = (radix == 1) ? symtab[parseInt(word)] : symtab[unbase.unbase(word)];
        return w2 || word;
    }
    return payload.replace(/\b\w+\b/g, lookup);
}

function _filterargs(source) {
    const juicers = [
        /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
        /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)/
    ];
    for (const j of juicers) {
        const a = j.exec(source);
        if (a) {
            return {
                payload: a[1],
                symtab:  a[4].split("|"),
                radix:   parseInt(a[2]),
                count:   parseInt(a[3])
            };
        }
    }
    throw Error("Could not make sense of p.a.c.k.e.r data");
}

/* ------------------------------------------------------------------ */
/*  BASE64 + AES-256-CTR (pure JS, used for AllAnime "tobeparsed")    */
/* ------------------------------------------------------------------ */
function b64ToBytes(b64) {
    if (typeof atob === "function") {
        const s = atob(b64);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }
    const tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    b64 = b64.replace(/[^A-Za-z0-9+/=]/g, "");
    const len = (b64.length * 3) >> 2;
    const out = new Uint8Array(len - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0));
    let p = 0;
    for (let i = 0; i < b64.length; i += 4) {
        const a = tbl.indexOf(b64[i]);
        const b = tbl.indexOf(b64[i+1]);
        const c = tbl.indexOf(b64[i+2]);
        const d = tbl.indexOf(b64[i+3]);
        const n = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
        if (p < out.length) out[p++] = (n >> 16) & 0xff;
        if (p < out.length) out[p++] = (n >> 8) & 0xff;
        if (p < out.length) out[p++] = n & 0xff;
    }
    return out;
}

// Minimal AES-256 (14 rounds) + CTR mode.
const _AES_SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
]);

function _aesXtime(x) { return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff; }

function _aesKeyExpand256(key) {
    const Nk = 8, Nr = 14, Nb = 4;
    const w = new Uint8Array(4 * Nb * (Nr + 1));
    for (let i = 0; i < Nk * 4; i++) w[i] = key[i];
    const rcon = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
    for (let i = Nk; i < Nb * (Nr + 1); i++) {
        let t0 = w[(i - 1) * 4], t1 = w[(i - 1) * 4 + 1],
            t2 = w[(i - 1) * 4 + 2], t3 = w[(i - 1) * 4 + 3];
        if (i % Nk === 0) {
            const u0 = _AES_SBOX[t1], u1 = _AES_SBOX[t2],
                  u2 = _AES_SBOX[t3], u3 = _AES_SBOX[t0];
            t0 = u0 ^ rcon[(i / Nk) - 1]; t1 = u1; t2 = u2; t3 = u3;
        } else if (i % Nk === 4) {
            t0 = _AES_SBOX[t0]; t1 = _AES_SBOX[t1];
            t2 = _AES_SBOX[t2]; t3 = _AES_SBOX[t3];
        }
        w[i * 4]     = w[(i - Nk) * 4]     ^ t0;
        w[i * 4 + 1] = w[(i - Nk) * 4 + 1] ^ t1;
        w[i * 4 + 2] = w[(i - Nk) * 4 + 2] ^ t2;
        w[i * 4 + 3] = w[(i - Nk) * 4 + 3] ^ t3;
    }
    return w;
}

function _aesEncryptBlock(state, w) {
    const Nr = 14;
    // AddRoundKey
    for (let i = 0; i < 16; i++) state[i] ^= w[i];
    for (let r = 1; r < Nr; r++) {
        // SubBytes
        for (let i = 0; i < 16; i++) state[i] = _AES_SBOX[state[i]];
        // ShiftRows
        let t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
        t = state[2]; state[2] = state[10]; state[10] = t;
        t = state[6]; state[6] = state[14]; state[14] = t;
        t = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t;
        // MixColumns
        for (let c = 0; c < 4; c++) {
            const a0 = state[c*4], a1 = state[c*4+1], a2 = state[c*4+2], a3 = state[c*4+3];
            const t2 = a0 ^ a1 ^ a2 ^ a3;
            state[c*4]   ^= t2 ^ _aesXtime(a0 ^ a1);
            state[c*4+1] ^= t2 ^ _aesXtime(a1 ^ a2);
            state[c*4+2] ^= t2 ^ _aesXtime(a2 ^ a3);
            state[c*4+3] ^= t2 ^ _aesXtime(a3 ^ a0);
        }
        // AddRoundKey
        for (let i = 0; i < 16; i++) state[i] ^= w[r * 16 + i];
    }
    // Final round (no MixColumns)
    for (let i = 0; i < 16; i++) state[i] = _AES_SBOX[state[i]];
    let t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
    t = state[2]; state[2] = state[10]; state[10] = t;
    t = state[6]; state[6] = state[14]; state[14] = t;
    t = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t;
    for (let i = 0; i < 16; i++) state[i] ^= w[Nr * 16 + i];
}

function _aesCtr(key, counter, ciphertext) {
    const w = _aesKeyExpand256(key);
    const out = new Uint8Array(ciphertext.length);
    const block = new Uint8Array(16);
    const ctr = new Uint8Array(counter);
    for (let off = 0; off < ciphertext.length; off += 16) {
        for (let i = 0; i < 16; i++) block[i] = ctr[i];
        _aesEncryptBlock(block, w);
        const n = Math.min(16, ciphertext.length - off);
        for (let i = 0; i < n; i++) out[off + i] = ciphertext[off + i] ^ block[i];
        // increment 32-bit counter (last 4 bytes, big-endian)
        for (let i = 15; i >= 12; i--) {
            ctr[i] = (ctr[i] + 1) & 0xff;
            if (ctr[i] !== 0) break;
        }
    }
    return out;
}

// Decrypt the AllAnime "tobeparsed" base64 blob.
// Layout: 1 marker byte | 12 bytes IV | ciphertext | 16 trailing bytes (ignored).
// Counter starts at IV || 0x00000002 (big-endian).
function aesCtrDecryptBlob(b64, key) {
    const buf = b64ToBytes(b64);
    if (buf.length < 1 + 12 + 16) throw new Error("blob too small");
    const iv = buf.slice(1, 13);
    const ct = buf.slice(13, buf.length - 16);
    const counter = new Uint8Array(16);
    counter.set(iv, 0);
    counter[12] = 0; counter[13] = 0; counter[14] = 0; counter[15] = 2;
    const pt = _aesCtr(key, counter, ct);
    let s = "";
    for (let i = 0; i < pt.length; i++) s += String.fromCharCode(pt[i]);
    return s;
}

