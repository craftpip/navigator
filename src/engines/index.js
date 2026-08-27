import { POOL_POLICIES, SearchEngineDriver } from "./driver.js";
import { DuckDuckGoApiDriver } from "./duckduckgo-api.js";
import { DuckDuckGoEngine } from "./duckduckgo.js";
import { ExaApiDriver } from "./exa-api.js";
import { FirecrawlApiDriver } from "./firecrawl-api.js";
import { LinkupApiDriver } from "./linkup-api.js";
import { TavilyApiDriver } from "./tavily-api.js";
import { GoogleEngine } from "./google.js";
import { BingEngine } from "./bing.js";
import { BraveEngine } from "./brave.js";
import { MojeekEngine } from "./mojeek.js";
import { StartpageEngine } from "./startpage.js";
import { YahooEngine } from "./yahoo.js";

const DRIVER_CLASSES = [
  DuckDuckGoEngine,
  DuckDuckGoApiDriver,
  GoogleEngine,
  BingEngine,
  BraveEngine,
  MojeekEngine,
  StartpageEngine,
  YahooEngine,
  ExaApiDriver,
  FirecrawlApiDriver,
  LinkupApiDriver,
  TavilyApiDriver,
];

const REGISTRY = new Map();
const ENGINE_METADATA = new Map();

for (const DriverClass of DRIVER_CLASSES) {
  const instance = new DriverClass();
  const id = String(instance.id || "").toLowerCase();
  if (!id) {
    throw new Error(`Search engine driver ${DriverClass.name} has no id`);
  }
  if (REGISTRY.has(id)) {
    throw new Error(`Duplicate search engine id registered: ${id}`);
  }

  const isBrowser = instance.pool !== null;
  if (isBrowser) {
    if (!instance.homeUrl) {
      throw new Error(`Search engine ${id} is a browser route but has no homeUrl`);
    }
    if (!POOL_POLICIES.has(instance.pool)) {
      throw new Error(`Search engine ${id} has invalid pool policy: ${instance.pool}`);
    }
    if (typeof instance.searchUrl !== "function" || instance.searchUrl === SearchEngineDriver.prototype.searchUrl) {
      throw new Error(`Search engine ${id} is a browser route but does not implement searchUrl()`);
    }
    if (typeof instance.extract !== "function" || instance.extract === SearchEngineDriver.prototype.extract) {
      throw new Error(`Search engine ${id} is a browser route but does not implement extract()`);
    }
  } else {
    if (instance.pool != null) {
      throw new Error(`Search engine ${id} is an API route but declares a pool: ${instance.pool}`);
    }
    if (instance.homeUrl) {
      throw new Error(`Search engine ${id} is an API route but declares a homeUrl`);
    }
    if (typeof instance.search !== "function" || instance.search === SearchEngineDriver.prototype.search) {
      throw new Error(`Search engine ${id} is an API route but does not implement search()`);
    }
  }

  REGISTRY.set(id, DriverClass);
  ENGINE_METADATA.set(id, {
    pool: instance.pool,
    homeUrl: instance.homeUrl,
    isBrowser
  });
}

export const SUPPORTED_ENGINES = Object.freeze([...REGISTRY.keys()]);

export function getEngineDriver(engine, config) {
  const DriverClass = REGISTRY.get(String(engine || "").toLowerCase());
  if (!DriverClass) {
    throw new Error(`Unknown search engine: ${engine}`);
  }
  return new DriverClass(config);
}

export function getEngineMetadata(engine) {
  return ENGINE_METADATA.get(String(engine || "").toLowerCase()) || null;
}

export function getBrowserWarmupEngines(engines) {
  const input = Array.isArray(engines) ? engines : [];
  const seen = new Set();
  const result = [];
  for (const item of input) {
    const id = String(item || "").trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (ENGINE_METADATA.get(id)?.isBrowser) {
      result.push(id);
    }
  }
  return result;
}
