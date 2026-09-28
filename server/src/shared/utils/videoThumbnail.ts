import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

ffmpeg.setFfmpegPath(ffmpegPath.path);

/**
 * Extracts a single poster frame from a video buffer, ~1 second in (falls
 * back to the very first frame for very short clips). fluent-ffmpeg only
 * reads/writes real files, not buffers directly, so this round-trips
 * through a couple of temp files and cleans them up unconditionally.
 */
export async function extractVideoPosterFrame(videoBuffer: Buffer): Promise<Buffer> {
  const tmpDir = os.tmpdir();
  const id = randomUUID();
  const inputPath = path.join(tmpDir, `${id}-in.mp4`);
  const outputPath = path.join(tmpDir, `${id}-out.jpg`);

  try {
    await fs.writeFile(inputPath, videoBuffer);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: ['1'],
          filename: path.basename(outputPath),
          folder: tmpDir,
          size: '480x?',
        });
    });

    return await fs.readFile(outputPath);
  } finally {
    await Promise.all([
      fs.unlink(inputPath).catch(() => {}),
      fs.unlink(outputPath).catch(() => {}),
    ]);
  }
}
