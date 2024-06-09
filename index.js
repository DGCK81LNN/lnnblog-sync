import axios from "axios"
import { wrapper as cookieJarWrapper } from "axios-cookiejar-support"
import "dotenv/config"
import repl from "repl"
import { CookieJar } from "tough-cookie"

const sourceIndexPhp = process.env["SOURCE_INDEXPHP"]
const sourceApiPhp = process.env["SOURCE_APIPHP"]
const sourceUsername = process.env["SOURCE_USERNAME"]
const sourcePassword = process.env["SOURCE_PASSWORD"]
const targetApiPhp = process.env["TARGET_APIPHP"]
const targetUsername = process.env["TARGET_USERNAME"]
const targetPassword = process.env["TARGET_PASSWORD"]
const lastSync = process.env["LAST_SYNC"]

if (!sourceIndexPhp) throw new Error("SOURCE_INDEXPHP not specified")
if (!sourceApiPhp) throw new Error("SOURCE_APIPHP not specified")
if (!targetApiPhp) throw new Error("TARGET_APIPHP not specified")
if (!targetUsername) throw new Error("TARGET_USERNAME not specified")
if (!targetPassword) throw new Error("TARGET_PASSWORD not specified")
if (!lastSync) throw new Error("LAST_SYNC not specified")

class APIError extends Error {
  name = "APIError"
  constructor(message, data) {
    Object.assign(this, data)
    super(message)
  }
}

const jar = new CookieJar()
const axi = axios.create({ jar })
const ax = cookieJarWrapper(axi)

axi.defaults.headers.common["User-Agent"] =
  "lnnblog-syncbot/0.1 (User:DGCK81LNN; lnn@vudrux.site) LNNBot/0"
axi.defaults.headers.post["Content-Type"] = "multipart/form-data"

/**
 * @template [A=T]
 * @template [T=any]
 * @template [R=import("axios").AxiosResponse<T>]
 * @template [D=any]
 * @param {string} url
 * @param {import("axios").AxiosRequestConfig<D>} opt
 * @param {((data: T) => T is A)?} assertion
 * @returns {Promise<A>}
 */
async function api(url, opt, assertion) {
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
  return data
}

/**
 * @template [A=any]
 * @template {{ query?: A, continue?: unknown }} [T={ query?: A, continue?: { continue: string } }]
 * @template [D=any]
 * @param {string} url
 * @param {import("axios").AxiosRequestConfig<D>} opt
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

  return {
    ...data,
    query: results,
  }
}

async function apiLogin(url, username, password) {
  console.log(`  ...fetch login token`)
  const {
    query: {
      tokens: { logintoken },
    },
  } = await api(url, {
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
      method: "post",
      params: {
        action: "login",
      },
      data: {
        lgname: username,
        lgpassword: password,
        lgtoken: logintoken,
      },
    },
    d => d.login.result === "Success"
  )
}

if (sourceUsername && sourcePassword) {
  console.log("Log in to source site...")
  const {
    login: { lgusername },
  } = await apiLogin(sourceApiPhp, sourceUsername, sourcePassword)
  console.log(`Logged in to source site as ${lgusername}`)
} else {
  console.log("Credentials not specified, skip logging in to source site")
}

console.log("Fetch excluded page list...")
const {
  query: { categorymembers: excludedPages },
} = await apiQueryListAll(sourceApiPhp, {
  params: {
    list: "categorymembers",
    cmtitle: "Category:禁止自动同步",
    cmprop: "title",
    cmlimit: "100",
  },
})

console.log("Fetch logs...")
const {
  query: { recentchanges: changes },
  //curtimestamp: syncTimestamp,
} = await apiQueryListAll(sourceApiPhp, {
  params: {
    list: "recentchanges",
    rcstart: lastSync,
    rcdir: "newer",
    rclimit: "100",
    rcnamespace: "0|6|8|10|14|828",
    rcprop: "title|ids|timestamp|loginfo",
    rctype: "edit|new|log",
    //curtimestamp: "1",
  },
})

/** @type {Map<string, string>} */
const titleMapping = new Map()
/** @type {Map<string, number>} */
const fileIds = new Map()
for (const { type, title, pageid, logtype, logaction, logparams } of changes) {
  if (type === "new") {
    titleMapping.has(title) || titleMapping.set(title, "")
  } else if (type === "edit") {
    titleMapping.has(title) || titleMapping.set(title, title)
  } else if (type === "log") {
    if (logtype === "delete" && logaction == "delete") {
      titleMapping.delete(title)
    } else if (logtype === "move") {
      const oldTitle = titleMapping.get(title) ?? title
      titleMapping.set(logparams.target_title, oldTitle)
      if (logparams.suppressredirect) titleMapping.delete(title)
      else titleMapping.set(title, "")
    } else if (logtype === "upload") {
      fileIds.set(title, pageid)
    }
  }
}

const moves = Array.from(titleMapping).filter(
  ([to, from]) => from && to !== from
)

{
  console.log("Log in to target site...")
  const {
    login: { lgusername },
  } = await apiLogin(targetApiPhp, targetUsername, targetPassword)
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

console.log("Move pages...")

Object.assign(repl.start().context, {
  api,
  apiLogin,
  apiQueryListAll,
  changes,
  csrftoken,
  excludedPages,
  lastSync,
  sourceApiPhp,
  sourceIndexPhp,
  sourcePassword,
  sourceUsername,
  targetApiPhp,
  targetPassword,
  targetUsername,
  titleMapping,
  fileIds,
})
