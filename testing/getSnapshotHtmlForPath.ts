import { format } from 'prettier';

export async function getSnapshotHtmlForPath(path: string) {
  const response = await fetch(`${process.env.URL}test/${path}`);
  const html = await response.text();
  const pure = html.replace(/^.*<\/script>/s, '').replace(/ astro-\w+/g, '');
  return format(pure, { parser: 'html' });
}