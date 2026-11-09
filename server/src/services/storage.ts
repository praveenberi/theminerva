import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest } from '../lib/http.js';

/** Cloudinary is used for uploads when all three CLOUDINARY_* variables are set; otherwise files go to local disk. */
export const cloudinaryConfigured = () => !!(config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET);

/** Signed upload (no SDK): sha1 of the sorted params + API secret, as Cloudinary documents. */
export function cloudinarySignature(params: Record<string, string | number>, secret: string) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

/** Store an already-validated image in Cloudinary and return a delivery URL (auto format/quality, max 1600px wide). */
export async function uploadToCloudinary(buf: Buffer, mime: string): Promise<{ url: string; size: number }> {
  const cloud = config.CLOUDINARY_CLOUD_NAME!;
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'theminerva';
  const signature = cloudinarySignature({ folder, timestamp }, config.CLOUDINARY_API_SECRET!);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), 'upload');
  fd.append('api_key', config.CLOUDINARY_API_KEY!);
  fd.append('timestamp', String(timestamp));
  fd.append('folder', folder);
  fd.append('signature', signature);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: fd });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok || !body.secure_url) throw badRequest(`Image storage rejected the upload${body?.error?.message ? `: ${body.error.message}` : ''}`);
  return { url: String(body.secure_url).replace('/image/upload/', '/image/upload/f_auto,q_auto,w_1600,c_limit/'), size: buf.length };
}
