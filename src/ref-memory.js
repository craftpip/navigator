import { clearRefLinks, getRefLinkById, getRefLinkByUrl, rememberRefLink } from "./db.js";

const MAX_LINK_MEMORY_ENTRIES = 2000;

const linkMemoryByRef = new Map();
const linkMemoryByUrl = new Map();

function cacheLink(ref, url) {
  linkMemoryByRef.set(ref, url);
  linkMemoryByUrl.set(url, ref);
  pruneLinkMemory();
}

export function getRememberedLinkRecord(ref) {
  const cachedUrl = linkMemoryByRef.get(ref);
  if (cachedUrl) return { url: cachedUrl };

  const remembered = getRefLinkById(ref);
  if (!remembered) return null;
  cacheLink(remembered.id, remembered.url);
  return { url: remembered.url };
}

function pruneLinkMemory() {
  while (linkMemoryByRef.size > MAX_LINK_MEMORY_ENTRIES) {
    const oldestRef = linkMemoryByRef.keys().next().value;
    if (oldestRef === undefined) break;
    const rememberedUrl = linkMemoryByRef.get(oldestRef);
    linkMemoryByRef.delete(oldestRef);
    if (rememberedUrl) {
      linkMemoryByUrl.delete(rememberedUrl);
    }
  }
}

export function clearLinkRefMemory() {
  const cleared = {
    memoryRefs: linkMemoryByRef.size,
    memoryUrls: linkMemoryByUrl.size,
    persistedRefs: clearRefLinks()
  };
  linkMemoryByRef.clear();
  linkMemoryByUrl.clear();
  return cleared;
}

export function rememberLink(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return null;

  const existingRef = linkMemoryByUrl.get(normalized);
  if (existingRef) return existingRef;

  const ref = rememberRefLink(normalized);
  if (!ref) return null;
  cacheLink(ref, normalized);
  return ref;
}

export function resolveRefIdToUrl(ref) {
  const remembered = getRememberedLinkRecord(ref);
  if (!remembered?.url) {
    throw new Error(`No link found in memory for ref ${ref}`);
  }
  return remembered.url;
}

export function getLinkRefByUrl(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return null;

  const cachedRef = linkMemoryByUrl.get(normalized);
  if (cachedRef) return cachedRef;

  const remembered = getRefLinkByUrl(normalized);
  if (!remembered) return null;
  cacheLink(remembered.id, remembered.url);
  return remembered.id;
}

export function getUrlForRefId(ref) {
  return getRememberedLinkRecord(ref)?.url ?? null;
}
