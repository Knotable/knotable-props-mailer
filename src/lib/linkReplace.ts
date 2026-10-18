// Replaces every occurrence of one URL, including its HTML-escaped form
// (& → &amp;), and reports how many were changed.
export function replaceLink(source: string, find: string, replace: string): { value: string; count: number } {
  let value = source;
  let count = 0;
  const escape = (url: string) => url.replace(/&/g, "&amp;");
  const pairs: Array<[string, string]> = [[find, replace]];
  if (escape(find) !== find) pairs.push([escape(find), escape(replace)]);
  for (const [from, to] of pairs) {
    const parts = value.split(from);
    count += parts.length - 1;
    value = parts.join(to);
  }
  return { value, count };
}
