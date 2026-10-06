import { useState, useEffect } from 'react';

/**
 * Custom hook that fetches Lottie JSON animation data from a URL.
 * Returns the parsed JSON data, or null while loading / on error.
 * Handles cleanup to avoid setting state on unmounted components.
 *
 * @param {string} url - The URL to fetch the Lottie JSON from.
 * @returns {object|null} The parsed animation data, or null.
 */
export function useLottieUrl(url) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!url) {
      setData(null);
      return;
    }

    let cancelled = false;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return data;
}
