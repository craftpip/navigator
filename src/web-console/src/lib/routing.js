export function modeFromPath(pathname) {
  if (pathname === "/console/tools" || pathname === "/console/api")
    return "tools";
  if (pathname === "/console/manage") return "manage";
  if (pathname === "/console/keys") return "keys";
  if (pathname === "/console/hints" || pathname.startsWith("/console/hints/"))
    return "hints";
  return "status";
}

export function editorFromPath(pathname) {
  if (pathname === "/console/hints/new") return { index: null };
  const match = pathname.match(/^\/console\/hints\/edit\/(\d+)$/);
  if (match) return { index: Number(match[1]) };
  return null;
}

export function pathForMode(mode) {
  if (mode === "tools") return "/console/tools";
  if (mode === "manage") return "/console/manage";
  if (mode === "keys") return "/console/keys";
  if (mode === "hints") return "/console/hints";
  return "/console";
}
