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

function pickTitle(obj) {
    if (!obj) return "Unknown";
    return obj.englishName || obj.name || obj.nativeName || "Unknown";
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
            image: a && a.thumbnail ? a.thumbnail : "",
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

    const data = await gql(STREAM_QUERY, variable, "stream-" + type);

    const sources = (data && data.data && data.data.episode && data.data.episode.sourceUrls) || [];
    if (!sources.length) {
        logDbg("stream-" + type, "no sourceUrls");
        return [];
    }

    const pick = name => sources.filter(x => x && x.sourceName === name);

    const defaultVal  = pick("Default");
    const mp4Val      = pick("Mp4");
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

    // Default (allmanga internal)
    try {
        if (defaultVal.length) {
            const dec = decryptSource(defaultVal[0].sourceUrl);
            const u   = await defaultExtractor(dec.replace("/clock?", "/clock.json?"));
            if (u) streams.push(`Default ${type}`, u);
        }
    } catch (e) { logErr("default", e); }

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
