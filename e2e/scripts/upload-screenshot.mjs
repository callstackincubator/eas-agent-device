// Uploads a PNG to Vercel Blob and prints its public URL; prints nothing
// without BLOB_READ_WRITE_TOKEN, so callers can treat an empty result as "no URL".
//
// Usage: node scripts/upload-screenshot.mjs <file> <blob-path>

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { put } from '@vercel/blob';

const [file, pathname] = process.argv.slice(2);
if (!file || !pathname) {
  console.error('usage: upload-screenshot.mjs <file> <blob-path>');
  process.exit(2);
}
if (process.env.BLOB_READ_WRITE_TOKEN) {
  const blob = await put(pathname, await readFile(file), {
    access: 'public',
    addRandomSuffix: true,
    contentType: 'image/png',
  });
  process.stdout.write(blob.url);
}
