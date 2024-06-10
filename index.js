import "dotenv/config"

import axios, { AxiosError } from "axios"
import { createCookieAgent } from "http-cookie-agent/http"
import { ProxyAgent } from "proxy-agent"
import { CookieJar } from "tough-cookie"

import { readFile, writeFile } from "fs/promises"
import { inspect } from "util"

const sourceApiPhp = process.env["SOURCE_APIPHP"]
const sourceUsername = process.env["SOURCE_USERNAME"]
const sourcePassword = process.env["SOURCE_PASSWORD"]
const targetApiPhp = process.env["TARGET_APIPHP"]
const targetUsername = process.env["TARGET_USERNAME"]
const targetPassword = process.env["TARGET_PASSWORD"]
const lastSync =
  process.env["LAST_SYNC"] || (await readFile("~lastsync", "utf8")).trim()
const mockLogin = "MOCK_LOGIN" in process.env
const saveMockFlag = "SAVE_MOCK" in process.env

if (!sourceApiPhp) throw new Error("SOURCE_APIPHP not specified")
if (!targetApiPhp) throw new Error("TARGET_APIPHP not specified")
if (!targetUsername) throw new Error("TARGET_USERNAME not specified")
if (!targetPassword) throw new Error("TARGET_PASSWORD not specified")
if (!lastSync) throw new Error("LAST_SYNC not specified")

/** @type {Record<string, *>} */
const mock = await readFile("~mockfile.json", "utf8").then(
  f => JSON.parse(f),
  () => ({})
)
async function saveMock(x) {
  await writeFile("~mockfile.json", JSON.stringify(mock, null, 2))
  return x
}

class APIError extends Error {
  name = "APIError"
  constructor(message, data) {
    super(message)
    Object.assign(this, data)
  }
}

const CookieProxyAgent = createCookieAgent(ProxyAgent)

const jar = new CookieJar()
const agent = new CookieProxyAgent({ cookies: { jar } })
const axi = axios.create({
  proxy: false,
  httpsAgent: agent,
  httpAgent: agent,
  headers: {
    common: {
      "User-Agent":
        "lnnblog-syncbot/0.1 (User:DGCK81LNN; lnn@vudrux.site) LNNBot/0",
    },
    post: {
      "Content-Type": "multipart/form-data",
    },
  },
})

/** @type {typeof axi} */
const ax = new Proxy(axi, {
  apply(axi, self, args) {
    return axi.apply(axi, args).catch(exc => {
      if (exc instanceof AxiosError) {
        Object.defineProperties(exc, {
          config: { enumerable: false },
          request: { enumerable: false },
        })
        const { response } = exc
        if (response)
          for (const key of Object.keys(response)) {
            if (!["status", "statusText", "headers", "data"].includes(key))
              Object.defineProperty(response, key, { enumerable: false })
          }
      }
      return Promise.reject(exc)
    })
  },
})

/**
 * Set `opt._mock` to a non-empty string to cache the result;
 * set to the empty string to mark the API call as a data-modifying action
 * which can be dropped by adding `"": {}` in the mockfile.
 *
 * @template [A=T]
 * @template [T=any]
 * @template [R=import("axios").AxiosResponse<T>]
 * @template [D=any]
 * @param {string} url
 * @param {import("axios").AxiosRequestConfig<D> & { _mock?: string }} opt
 * @param {((data: T) => T is A)?} assertion
 * @returns {Promise<A>}
 */
async function api(url, opt, assertion) {
  process.stdout.write(
    (
      "api call " +
      inspect(
        { url, ...opt },
        {
          colors: process.stdout.isTTY && process.stdout.hasColors(),
          maxStringLength: "1000",
        }
      )
    ).replace(/^/gm, "    ") + "\n"
  )
  if (typeof opt?._mock === "string" && Object.hasOwn(mock, opt._mock))
    return Promise.resolve(mock[opt._mock])
  try {
    /** @type {R} */
    const resp = await ax(url, {
      ...opt,
      params: {
        format: "json",
        formatversion: 2,
        errorformat: "plaintext",
        errorlang: "content",
        ...opt.params,
      },
    })
    const data = resp.data
    if (typeof data === "object") {
      if (data.errors?.length) throw new APIError("API call errored", data)
      if (data.warnings?.length) {
        process.emitWarning("API call returned one or more warnings")
        console.warn(data.warnings)
      }
    }
    if (assertion && !assertion(data))
      throw new APIError("API action failed", data)
    if (opt?._mock) mock[opt._mock] = data
    return data
  } finally {
    if (saveMockFlag) await saveMock()
  }
}

/**
 * @template [A=any]
 * @template {{ query?: A, continue?: unknown }} [T={ query?: A, continue?: { continue: string } }]
 * @template [D=any]
 * @param {string} url
 * @param {import("axios").AxiosRequestConfig<D> & { _mock?: string }} opt
 * @returns {Promise<A>}
 */
async function apiQueryListAll(url, opt) {
  /** @type {T} */
  let data
  /** @type {A} */
  let results
  let page = 0
  do {
    console.log(`  ...page ${++page}`)
    data = await api(url, {
      ...opt,
      params: {
        action: "query",
        ...opt.params,
        ...data?.continue,
      },
    })
    if (!data.query) break
    if (!results) {
      results = data.query
    } else {
      for (const [key, value] of Object.entries(data.query)) {
        const currValue = results[key]
        if (Array.isArray(currValue)) currValue.push(...value)
        else results[key] = value
      }
    }
  } while (typeof data.continue?.continue === "string")
  console.log("  ...end")

  data.query = results
  if (opt?._mock) mock[opt._mock] = data
  return data
}

/**
 * @param {string} url
 * @param {string} username
 * @param {string} password
 * @param {boolean | ""} [_mock=]
 */
async function apiLogin(url, username, password, _mock) {
  if (_mock === "" && "login" in mock) return mock["login"]
  console.log(`  ...fetch login token`)
  const {
    query: {
      tokens: { logintoken },
    },
  } = await api(url, {
    _mock: _mock && "logintoken",
    params: {
      action: "query",
      meta: "tokens",
      type: "login",
    },
  })
  console.log(`  ...log in`)
  return api(
    url,
    {
      _mock: _mock && "login",
      method: "post",
      params: {
        action: "login",
      },
      data: Object.defineProperty(
        {
          lgname: username,
          lgpassword: password,
          lgtoken: logintoken,
        },
        inspect.custom,
        {
          value: function () {
            return {
              ...this,
              lgpassword: {
                [inspect.custom](_, opt) {
                  return opt.stylize("[***]", "special")
                },
              },
            }
          },
        }
      ),
    },
    d => d.login.result === "Success"
  )
}

if (sourceUsername && sourcePassword) {
  console.log("Log in to source site...")
  const {
    login: { lgusername },
  } = await apiLogin(sourceApiPhp, sourceUsername, sourcePassword, mockLogin)
  console.log(`Logged in to source site as ${lgusername}`)
} else {
  console.log("Credentials not specified, skip logging in to source site")
}

console.log("Fetch excluded page list...")
let excludedPages = new Set()
{
  const {
    query: { categorymembers },
  } = await apiQueryListAll(sourceApiPhp, {
    _mock: "excludedpages",
    params: {
      list: "categorymembers",
      cmtitle: "Category:禁止自动同步",
      cmprop: "title",
      cmlimit: "100",
    },
  })
  for (const { title } of categorymembers) {
    excludedPages.add(title)
  }
}

console.log("Fetch logs...")
const {
  query: { recentchanges: changes },
  curtimestamp: syncTime,
} = await apiQueryListAll(sourceApiPhp, {
  _mock: "recentchanges",
  params: {
    list: "recentchanges",
    rcstart: lastSync,
    rcdir: "newer",
    rclimit: "100",
    rcnamespace: "0|6|8|10|14|828",
    rcprop: "title|ids|flags|timestamp|loginfo",
    rctype: "edit|new|log",
    curtimestamp: "1",
  },
})

/** @type {Map<string, { oldTitle?: string, minor: boolean }>} */
const pages = new Map()
/** @type {Map<string, number>} */
const fileIds = new Map()
for (const {
  type,
  title,
  pageid,
  minor,
  logtype,
  logaction,
  logparams,
} of changes) {
  if (type === "new" || type === "edit") {
    const info = pages.get(title)
    if (info) info.minor &&= !!minor
    else pages.set(title, { minor: !!minor })
  } else if (type === "log") {
    if (logtype === "delete" && logaction == "delete") {
      pages.delete(title)
    } else if (logtype === "move") {
      const info = pages.get(title) ?? { oldTitle: title, minor: true }
      pages.set(logparams.target_title, info)
      if (logparams.suppressredirect) pages.delete(title)
      else pages.set(title, { minor: false })
    } else if (logtype === "upload") {
      // Disabling this as file download does not seem to be available to bot logins on private wikis
      //fileIds.set(title, pageid)
    }
  }
}

console.log("Remove excluded titles from to-do list...")
for (const [newTitle, { oldTitle }] of pages) {
  if (
    excludedPages.has(newTitle) ||
    (oldTitle && excludedPages.has(oldTitle))
  ) {
    console.log(`  ...exclude ${newTitle}`)
    pages.delete(newTitle)
  }
}
for (const [title] of fileIds) {
  if (excludedPages.has(title)) {
    console.log(`  ...exclude upload ${title}`)
    fileIds.delete(title)
  }
}

console.log("\n============== TO-DO LIST ==============\n")
if (!pages.size && !fileIds.size) {
  console.log("Nothing to do today, bye")
  await writeFile("~lastsync", syncTime)
  process.exit(0)
}

/** @type {[from: string, to: string][]} */
const moves = Array.from(pages)
  .filter(([title, { oldTitle }]) => oldTitle && title !== oldTitle)
  .map(([title, { oldTitle }]) => [oldTitle, title])
if (moves.length) console.log("move", moves)

if (pages.size) console.log("import", [...pages.keys()])

if (fileIds.size) console.log("upload", [...fileIds.keys()])

console.log("\n========================================\n")

let xmlExport = ""
if (pages.size) {
  console.log("Export page revisions...")
  ;({
    query: { export: xmlExport },
  } = await api(sourceApiPhp, {
    _mock: "export",
    params: {
      action: "query",
      titles: [...pages.keys()].join("|"),
      export: "1",
    },
  }))
  // un-minor-ify revisions of pages that we know have recent non-minor revisions
  xmlExport = xmlExport.replace(
    /<title>\s*(.*?)\s*<\/title>.*?<\/revision>/gs,
    (str, title) => {
      if (pages.get(title)?.minor === false)
        str = str.replace(/\s*<minor\s*\/>/, "")
      return str
    }
  )
}

/** @type {Map<string, string>} */
const fileUrls = new Map()
if (fileIds.size) {
  console.log("Fetch file urls...")
  const {
    query: { pages },
  } = await api(sourceApiPhp, {
    _mock: "fileurls",
    params: {
      action: "query",
      prop: "imageinfo",
      iiprop: "url",
      pageids: [...fileIds.values()].join("|"),
    },
  })
  for (const {
    title,
    imageinfo: [{ url }],
  } of pages) {
    fileUrls.set(title, url)
  }
}

{
  console.log("Log in to target site...")
  const {
    login: { lgusername },
  } = await apiLogin(targetApiPhp, targetUsername, targetPassword, "" in mock)
  console.log(`Logged in to target site as ${lgusername}`)
}

console.log("Fetch CSRF token...")
const {
  query: {
    tokens: { csrftoken },
  },
} = await api(targetApiPhp, {
  params: {
    action: "query",
    meta: "tokens",
    type: "csrf",
  },
})

if (moves.length) {
  console.log("Move pages...")
  for (const [from, to] of moves) {
    console.log(`  ... ${from} --> ${to}`)
    await api(targetApiPhp, {
      _mock: "",
      method: "post",
      params: {
        action: "move",
      },
      data: {
        from: from,
        to: to,
        reason: "从分支站同步更改",
        noredirect: "true",
        tags: "syncbot",
        token: csrftoken,
      },
    }).catch(console.error)
  }
}

if (xmlExport) {
  console.log("Import page revisions...")
  const data = new FormData()
  data.append("xml", new File([xmlExport], "export.xml"))
  data.append("interwikiprefix", "1")
  data.append("assignknownusers", "1")
  data.append("summary", "从分支站同步更改")
  data.append("tags", "syncbot")
  data.append("token", csrftoken)
  console.log(
    await api(targetApiPhp, {
      _mock: "",
      method: "post",
      params: {
        action: "import",
      },
      data,
    })
  )
}

/*if (fileUrls.size) {
  console.log("Transfer files...")
  for (const [title, url] of fileUrls) {
    console.log(`  ... ${title}`)
    await ax(url, {
      _mock: "",
      responseType: "stream",
    })
      .then(({ data }) =>
        api(targetApiPhp, {
          _mock: "",
          method: "post",
          params: {
            action: "upload",
          },
          data: {
            filename: title,
            file: data,
            comment: "从分支站同步更改",
            ignorewarnings: "1",
            tags: "syncbot",
            token: csrftoken,
          },
        })
      )
      .catch(console.error)
  }
}*/

"REPL" in process.env &&
  Object.assign((await import("repl")).start().context, {
    api,
    apiLogin,
    apiQueryListAll,
    ax: axi,
    changes,
    csrftoken,
    excludedPages,
    fileIds,
    lastSync,
    mock,
    moves,
    pages,
    saveMock,
    sourceApiPhp,
    sourcePassword,
    sourceUsername,
    syncTime,
    targetApiPhp,
    targetPassword,
    targetUsername,
    xmlExport,
  })

await Promise.allSettled([
  saveMockFlag && saveMock(),
  writeFile("~lastsync", syncTime),
])
