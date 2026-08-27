import { useEffect, useState } from "react";

export function useNarrow(breakpoint = 720) {
  const query = `(max-width: ${breakpoint}px)`;
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e) => setNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return narrow;
}
