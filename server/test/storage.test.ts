import crypto from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import './env';
import { config } from '../src/config';
import { cloudinaryConfigured, cloudinarySignature, uploadToCloudinary } from '../src/services/storage';

describe('image storage (Cloudinary)', () => {
  afterEach(() => { vi.unstubAllGlobals(); config.CLOUDINARY_CLOUD_NAME = undefined; config.CLOUDINARY_API_KEY = undefined; config.CLOUDINARY_API_SECRET = undefined; });

  it('is off unless all three variables are set', () => {
    expect(cloudinaryConfigured()).toBe(false);
    config.CLOUDINARY_CLOUD_NAME = 'demo'; config.CLOUDINARY_API_KEY = 'k';
    expect(cloudinaryConfigured()).toBe(false);
    config.CLOUDINARY_API_SECRET = 's';
    expect(cloudinaryConfigured()).toBe(true);
  });

  it('signs sorted params with the secret appended (sha1)', () => {
    const expected = crypto.createHash('sha1').update('folder=theminerva&timestamp=123' + 'secret').digest('hex');
    expect(cloudinarySignature({ timestamp: 123, folder: 'theminerva' }, 'secret')).toBe(expected);
  });

  it('uploads, then returns an optimised delivery URL', async () => {
    config.CLOUDINARY_CLOUD_NAME = 'demo'; config.CLOUDINARY_API_KEY = 'key'; config.CLOUDINARY_API_SECRET = 'secret';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/theminerva/a.jpg' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await uploadToCloudinary(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg');
    expect(r.url).toBe('https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_1600,c_limit/v1/theminerva/a.jpg');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: FormData }];
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(init.body.get('api_key')).toBe('key');
    expect(init.body.get('signature')).toBeTruthy();
    expect(init.body.get('api_secret')).toBeNull(); // the secret itself is never sent
  });

  it('reports a clear error when storage rejects the file', async () => {
    config.CLOUDINARY_CLOUD_NAME = 'demo'; config.CLOUDINARY_API_KEY = 'key'; config.CLOUDINARY_API_SECRET = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid Signature' } }), { status: 401 })));
    await expect(uploadToCloudinary(Buffer.from([1, 2, 3]), 'image/png')).rejects.toThrow(/Invalid Signature/);
  });
});
