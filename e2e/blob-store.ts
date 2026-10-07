import type { ArtifactStore } from 'e2e';
import { put } from '@vercel/blob';

/**
 * Uploads screenshots to Vercel Blob so the PR comment can embed them; the
 * public URL lands in report.json as the artifact's `ref`. Other artifacts stay
 * local and are uploaded with the `.e2e/` workflow artifact.
 */
export function blobStore(prefix: string): ArtifactStore {
  return {
    async put(artifact) {
      if (artifact.kind !== 'screenshot') return { ref: artifact.path };
      const blob = await put(`${prefix}/${artifact.path}`, Buffer.from(artifact.bytes), {
        access: 'public',
        addRandomSuffix: true,
        contentType: artifact.mediaType,
      });
      return { ref: blob.url };
    },
  };
}
