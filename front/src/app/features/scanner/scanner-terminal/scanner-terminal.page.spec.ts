import * as QRCode from 'qrcode';
import { decodeVideoFrame } from './scanner-terminal.page';

describe('decodeVideoFrame (RF-13 cross-browser QR decoding)', () => {
  it('uses native BarcodeDetector when available', async () => {
    const fakeVideo = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
    const fakeDetector = {
      detect: async () => [{ rawValue: '  chk_native_qr_token  ' }],
    };

    const result = await decodeVideoFrame(fakeVideo, fakeDetector, null, null);
    expect(result).toBe('chk_native_qr_token');
  });

  it('falls back to jsQR on CanvasRenderingContext2D when BarcodeDetector is null (Safari/Firefox)', async () => {
    const expectedText = 'eyJhbGciOiJFUzI1NiJ9.test.sig';
    const qr = QRCode.create(expectedText, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    const scale = 6;
    const margin = 4;
    const dim = (count + margin * 2) * scale;
    const data = new Uint8ClampedArray(dim * dim * 4).fill(255);

    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!qr.modules.get(r, c)) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const y = (r + margin) * scale + dy;
            const x = (c + margin) * scale + dx;
            const idx = (y * dim + x) * 4;
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
          }
        }
      }
    }

    const fakeVideo = { videoWidth: dim, videoHeight: dim } as HTMLVideoElement;
    const fakeCanvas = { width: 0, height: 0 } as HTMLCanvasElement;
    let drawCalled = false;
    const fakeCtx = {
      drawImage: () => {
        drawCalled = true;
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data,
        width: w,
        height: h,
      }),
    } as unknown as CanvasRenderingContext2D;

    const result = await decodeVideoFrame(fakeVideo, null, fakeCtx, fakeCanvas);
    expect(drawCalled).toBe(true);
    expect(fakeCanvas.width).toBe(dim);
    expect(fakeCanvas.height).toBe(dim);
    expect(result).toBe(expectedText);
  });

  it('returns null when neither BarcodeDetector nor canvas context is available', async () => {
    const fakeVideo = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
    const result = await decodeVideoFrame(fakeVideo, null, null, null);
    expect(result).toBeNull();
  });
});
