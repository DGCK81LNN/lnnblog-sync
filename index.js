import axios from "axios"
import { wrapper as cookieJarWrapper } from "axios-cookiejar-support"
import "dotenv/config"
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
    super(message)
    this.data = data
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
 * @param {((data: T) => T is A)?} test
 * @returns {Promise<A>}
 */
async function api(url, opt, test) {
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
  if (data.errors?.length) throw new APIError("API call errored", data)
  if (data.warnings?.length) {
    process.emitWarning("API call returned one or more warnings")
    console.warn(data.warnings)
  }
  if (test && !test(data)) throw new APIError("API action failed", data)
  return data
}

/**
 * @template [A=any]
 * @template {{ query?: A, continue?: unknown }} [T={ query?: A, continue?: { continue: string } }]
 * @template [R=import("axios").AxiosResponse<T>]
 * @template [D=any]
 * @param {string} url
 * @param {import("axios").AxiosRequestConfig<D>} opt
 * @returns {Promise<A>}
 */
async function apiQueryAll(url, opt) {
  /** @type {T} */
  let data
  /** @type {A} */
  let results
  do {
    data = await api(url, {
      ...opt,
      params: {
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

  return {
    ...data,
    query: results,
  }
}

if (sourceUsername && sourcePassword) {
  console.log("Fetch login token for source site...")
  const {
    query: {
      tokens: { logintoken },
    },
  } = await api(sourceApiPhp, {
    params: {
      action: "query",
      meta: "tokens",
      type: "login",
    },
  })
  console.log("Log in to source site...")
  const {
    login: { lgusername },
  } = await api(
    sourceApiPhp,
    {
      method: "post",
      params: {
        action: "login",
      },
      data: {
        lgname: sourceUsername,
        lgpassword: sourcePassword,
        lgtoken: logintoken,
      },
    },
    d => d.login.result === "Success"
  )
  console.log(`Logged in to source site as ${lgusername}`)
} else {
  console.log("Credentials not specified, skip logging in to source site")
}

const { recentchanges: changes } = await apiQueryAll(sourceApiPhp, {
  params: {
    action: "query",
    list: "recentchanges",
    rcstart: lastSync,
    rcdir: "newer",
    rclimit: "100",
    rcnamespace: "0|6|8|10|14|828",
    rcprop: "title|timestamp|ids|loginfo|redirect",
    rctype: "edit|new|log|categorize",
  },
})
console.log(changes)
