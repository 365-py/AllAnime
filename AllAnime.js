	const apiUrl = "https://api.allanime.day/api"
const baseUrl = "https://allmanga.to"
const DEFAULT_HEADERS =  {
  "Content-Type": "application/json; charset=utf-8",
};
// GRAPHQL QUERIES
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
      }
    `;
const DETAIL_EPISODE_QUERY = `
      query($id: String!) {
        show(_id: $id) {
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
      }
    `;
const STREAM_QUERY =  `
query(
  $showId: String!
  $episodeString: String!
  $translationType: VaildTranslationTypeEnumType!
) {
  episode(
    showId: $showId
    episodeString: $episodeString
    translationType: $translationType
  ) {
    sourceUrls
  }
}
`;
async function searchResults(keyword) {
    try {

    const variable = {
      search: {
        query: keyword, 
        allowAdult: false,
        allowUnknown: false
      },
      countryOrigin: "ALL",
      limit: 26,
      page: 1
    };

    const response = await fetchv2(apiUrl, DEFAULT_HEADERS, "POST",{ query:SEARCH_QUERY.replace(/\n/g, ''),variables: variable })
        const data = await response.json();
        const resList = data.data.shows.edges    
        const transformedResults = resList.map(anime => ({
            title: anime.englishName,
            image: anime.thumbnail,
            href: anime._id
        }));
        
        return JSON.stringify(transformedResults);
        
    } catch (error) {
        console.log('Fetch error:', error);
        return JSON.stringify([{ title: 'Error', image: '', href: '' }]);
    }
}

async function extractDetails(id) {
    try {


    const variable = {id:id}
    const response = await fetchv2(`${apiUrl}`, DEFAULT_HEADERS, "POST",({ query:DETAIL_EPISODE_QUERY.replace(/\n/g, ''),variables: variable }))
        const data = await response.json();
        const anime = data.data.show
        const transformedResults = {
            description: htmlToText(anime.description).replace(/\n/g, '').replace(/\s+/g, " ")|| 'No description available',
            aliases: `Duration: ${'Unknown'}`,
            airdate: `Aired: ${anime.season.year || 'Unknown'}`
        };
        
        return JSON.stringify([transformedResults]);
    } catch (error) {
        console.log('Details error:', error);
        return JSON.stringify([{
        description: 'Error loading description',
        aliases: 'Duration: Unknown',
        airdate: 'Aired: Unknown'
        }]);
  }
}

async function extractEpisodes(id) {
    try {


    const variable = {id:id}
    const response = await fetchv2(`${apiUrl}`, DEFAULT_HEADERS, "POST",({ query:DETAIL_EPISODE_QUERY.replace(/\n/g, ''),variables: variable }))
        const data = await response.json();
        const anime = data.data.show
        console.log(anime)
        const transformedResults = anime.availableEpisodesDetail.sub.map((episode,idx) => ({
            href: JSON.stringify({showId:id,translationType:"sub",episodeString:episode}),
            number: parseFloat(episode) || 1
        }));
        
        return JSON.stringify(transformedResults.reverse());
        
    } catch (error) {
        console.log('Fetch error:', error);
    }    
}

async function extractStreamUrl(url) {
    try {
       var subArr = []
       try {
        subArr =  await exctractSubOrDubURLs(url,'sub')
       } catch (error) {
         console.log("failed extracting sub streams")
       }
       var dubArr= []
       try {
        dubArr = await exctractSubOrDubURLs(url,'dub')
       } catch (error) {
         console.log("failed extracting dub streams")
       }
       var streams = [...subArr, ...dubArr] 
       return JSON.stringify({streams:streams})
    } catch (error) {
       console.log('Fetch error:', error);
       return null;
    }
}

//util functions
// extract dub/subStream
 async function exctractSubOrDubURLs(url,type) {
          const variable = JSON.parse(url)
          variable['translationType'] = type
        const response = await fetchv2(`${apiUrl}`, DEFAULT_HEADERS, "POST",({ query:STREAM_QUERY.replace(/\n/g, ''),variables: variable }))

        const data = await response.json();
        const defaultVal = data.data.episode.sourceUrls.filter(x=> x.sourceName == "Default")
      const mp4Val = data.data.episode.sourceUrls.filter(x=> x.sourceName == "Mp4")
             const YtVal = data.data.episode.sourceUrls.filter(x=> x.sourceName == "Yt-mp4")
      const okVal = data.data.episode.sourceUrls.filter(x=> x.sourceName == "Ok")
      const swVal = data.data.episode.sourceUrls.filter(x=> x.sourceName == "Sw")
      const fileMoonVal = data.data.episode.sourceUrls.filter(x=> x.sourceName == "Fm-Hls")
      console.error(okVal)
      console.error(swVal)
      console.error(fileMoonVal)
       var streams = []
      try{
        if(fileMoonVal.length > 0)
        {
          const streamUrl = await filemoonExtractor(fileMoonVal[0].sourceUrl)
          if(streamUrl)
          {
            streams.push(`FileMoon ${type}`,streamUrl)
            
          }
        
        }
      }
      catch(e){console.error("fileMoon fetch error"); console.error(e.message)}
      try
      {
        if(swVal.length > 0)
        {
          const streamUrl = await streamWishExtractor(swVal[0].sourceUrl)
          if(streamUrl)
          {
            streams.push(`StreamWish ${type}`,streamUrl)
            
          }
        }
      }
      catch(e){console.error("streamwish fetch error");console.error(e.message)}
      try 
      {
        if(okVal.length > 0)
        {
          const streamUrl = await okruExtractor(okVal[0].sourceUrl)
          if(streamUrl)
          {
            streams.push(`okru ${type}`,streamUrl)
            
          }
        }
      } catch{console.error("OK fetch error")}
      try{
       if(mp4Val.length > 0)
        {
          const streamUrl = await mp4Extractor(mp4Val[0].sourceUrl)
          if(streamUrl)
          {
            streams.push(`MP4 ${type}`,streamUrl)
        
          }
        }
      }
      catch
      {
        console.error("mp4 fetch error")
      }
      try{
        if(defaultVal.length > 0)
         {
           const decrpytedUrl = decryptSource(defaultVal[0].sourceUrl)
           const streamUrl = await defaultExtractor(decrpytedUrl.replace("/clock?", "/clock.json?"))
            if(streamUrl)
           {
             streams.push(`Default ${type}`,streamUrl)
             
           }
           
           
         }}
      catch
      {
        console.error("default fetch error")
      }
        console.error(streams)
        return streams
 }
// decrpyt sourceUrl
function decryptSource(str) {
  if (str.startsWith("-")) {
      return str.substring(str.lastIndexOf('-') + 1)
          .match(/.{1,2}/g)
          .map(hex => parseInt(hex, 16))
          .map(byte => String.fromCharCode(byte ^ 56))
          .join("");
  } else {
      return str;
  }
}
function htmlToText(htmlText)
{
    let text = htmlText.replace(/<br\s*\/?>/gi, '\n');
// Decode HTML entities
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#x2014;': '—',
    '&#x2019;': '’',
    '&#x201c;': '“',
    '&#x201d;': '”',
    // Add more as needed
  };
  text = text.replace(/&#x[0-9a-fA-F]+;|&[a-z]+;/g, match => {
    if (entities[match]) return entities[match];

    // Handle numeric hex entities like &#x2014;
    if (/^&#x/.test(match)) {
      const code = parseInt(match.replace(/[&#x;]/g, ''), 16);
      return String.fromCharCode(code);
    }

    return match; // Unknown entity, leave as is
  });

  // Optionally remove any other HTML tags
  text = text.replace(/<[^>]*>/g, '');

  return text;
}
// extract URL based on sources

function extractFileMoonScript(html) {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const content = match[1];
    if (content.includes('eval') && content.includes('m3u8')) {
      return content;
    }
  }
  return null;
}
function extractIframeSrc(html) {
  const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/i;
  const match = html.match(iframeRegex);
  return match ? match[1] : null;
}
// filemoon extractor
async function filemoonExtractor(streamUrl) {
  const response = await fetchv2(streamUrl)
  const text = await response.text()
  //console.log("filemoon text is")
  const script = extractFileMoonScript(text)
  if(script){return script}
  const newUrl = extractIframeSrc(text)
  const newResponse = await fetchv2(newUrl)
  const newText = await newResponse.text()
  const newScript = extractFileMoonScript(newText)
  //console.log(newScript)
  const newStreamUrl = unpack(newScript);
  const m3u8Regex = /https?:\/\/[^\s]+master\.m3u8[^\s]*?(\?[^"]*)?/;
  const match = newStreamUrl.match(m3u8Regex);
  if(match)
    {
      console.log(match[0])
      return match[0]
    }

}
// streamWish extractor
async function streamWishExtractor(url)
{
  const response = await fetchv2(url)
  const text = await response.text()
  const unpacked = unpack(text)
  const m3u8Regex = /https?:\/\/[^\s]+master\.m3u8[^\s]*?(\?[^"]*)?/;
  const match = unpacked.match(m3u8Regex);
  if(match)
    {
      console.log(match[0])
      return match[0]
    }
}
// Default EXTRACTOR
async function defaultExtractor(url) {
    var res = await fetchv2(`${baseUrl}/getVersion`)
    var data = await res.json()
    const endPoint = data.episodeIframeHead
    res = await fetchv2(`${endPoint+url}`,{"Referer":baseUrl})
    data = await res.json()
    return data.links[0].link
  
  }
// OKRU extractor
async function okruExtractor(url) {
  const response = await fetchv2(url,{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"})
  const body = await response.text()
  const match = body.match(/data-options="([^"]*)"/);
  if(match)
    {
      const json = JSON.parse(match[1].replace(/&quot;/g, '"'))
      try
      {
        const metaData = JSON.parse(json["flashvars"]["metadata"])
        if(metaData['hlsManifestUrl'])
          {
            return metaData['hlsManifestUrl']
          }
        
        return metaData["ondemandHls"]

      }
      catch
      {
        console.error("json parse error")
      }

    }



  
}
// MP4 EXTRACTOR
async function mp4Extractor(url) {
  const Referer = "https://mp4upload.com"
  const headers = {"Referer":Referer}
  const response = await fetchv2(url,headers)
  const htmlText = await response.text()
  const streamUrl = extractMp4Script(htmlText)
  return streamUrl
}
function extractMp4Script(htmlText)
{
  const scripts = extractScriptTags(htmlText);
  let scriptContent = null;


  scriptContent = scripts.find(script =>
      script.includes('eval')
  );

  scriptContent = scripts.find(script => script.includes('player.src'));

  return scriptContent
  .split(".src(")[1]
  .split(")")[0]
  .split("src:")[1]
  .split('"')[1] || '';
}
// Extract all <script>...</script> blocks
function extractScriptTags(html) {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const scripts = [];
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
      scripts.push(match[1].trim());
  }

  return scripts;
}
/*
 * DEOBFUSCATOR CODE
 * 
 * Copy the below code fully and paste it in your
 * code. No need to modify anything.
 */

class Unbaser {
    constructor(base) {
        this.ALPHABET = {
            62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            95: "' !\"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'",
        };
        this.dictionary = {};
        this.base = base;
        if (36 < base && base < 62) {
            this.ALPHABET[base] = this.ALPHABET[base] ||
                this.ALPHABET[62].substr(0, base);
        }
        if (2 <= base && base <= 36) {
            this.unbase = (value) => parseInt(value, base);
        }
        else {
            try {
                [...this.ALPHABET[base]].forEach((cipher, index) => {
                    this.dictionary[cipher] = index;
                });
            }
            catch (er) {
                throw Error("Unsupported base encoding.");
            }
            this.unbase = this._dictunbaser;
        }
    }
    _dictunbaser(value) {
        let ret = 0;
        [...value].reverse().forEach((cipher, index) => {
            ret = ret + ((Math.pow(this.base, index)) * this.dictionary[cipher]);
        });
        return ret;
    }
}

function detect(source) {
    return source.replace(" ", "").startsWith("eval(function(p,a,c,k,e,");
}

function unpack(source) {
    let { payload, symtab, radix, count } = _filterargs(source);
    if (count != symtab.length) {
        throw Error("Malformed p.a.c.k.e.r. symtab.");
    }
    let unbase;
    try {
        unbase = new Unbaser(radix);
    }
    catch (e) {
        throw Error("Unknown p.a.c.k.e.r. encoding.");
    }
    function lookup(match) {
        const word = match;
        let word2;
        if (radix == 1) {
            word2 = symtab[parseInt(word)];
        }
        else {
            word2 = symtab[unbase.unbase(word)];
        }
        return word2 || word;
    }
    source = payload.replace(/\b\w+\b/g, lookup);
    return _replacestrings(source);
    function _filterargs(source) {
        const juicers = [
            /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
            /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)/,
        ];
        for (const juicer of juicers) {
            const args = juicer.exec(source);
            if (args) {
                let a = args;
                if (a[2] == "[]") {
                }
                try {
                    return {
                        payload: a[1],
                        symtab: a[4].split("|"),
                        radix: parseInt(a[2]),
                        count: parseInt(a[3]),
                    };
                }
                catch (ValueError) {
                    throw Error("Corrupted p.a.c.k.e.r. data.");
                }
            }
        }
        throw Error("Could not make sense of p.a.c.k.e.r data (unexpected code structure)");
    }
    function _replacestrings(source) {
        return source;
    }
}