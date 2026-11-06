// Only http and https links can be shortened.
export function isUrl(text) {
  try {
    return ["http:", "https:"].includes(new URL(text).protocol);
  } catch {
    return false;
  }
}
