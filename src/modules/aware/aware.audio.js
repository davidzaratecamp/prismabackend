/**
 * Proxy + transcodificación de las grabaciones de Aware.
 *
 * Las grabaciones del asesor humano vienen en WAV con códec **GSM 6.10**
 * (8 kHz), que los navegadores no reproducen; además el servidor de Aware las
 * entrega como `application/octet-stream`, así que un `<audio src>` directo
 * falla en silencio. Aquí se traen del servidor de Aware y se pasan por
 * `ffmpeg` a MP3 mono, que reproduce cualquier navegador.
 *
 * Requiere `ffmpeg` en el PATH del servidor (igual que VoxPro).
 */
import { spawn } from 'node:child_process';

/** Transcodifica `sourceUrl` (WAV/MP3 de Aware) a MP3 y lo escribe en `res`. */
export function streamAudioAsMp3(sourceUrl, res) {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');

  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      '-i', sourceUrl,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '48k',
      '-f', 'mp3',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  ff.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  ff.stdout.pipe(res);

  ff.on('error', (err) => {
    console.error('[aware audio] no se pudo ejecutar ffmpeg:', err.message);
    if (!res.headersSent) res.status(502);
    res.end();
  });

  ff.on('close', (code) => {
    if (code !== 0 && stderr) console.error('[aware audio] ffmpeg salió', code, stderr.slice(0, 300));
    if (!res.writableEnded) res.end();
  });

  // si el cliente corta la reproducción, matamos ffmpeg
  res.on('close', () => ff.kill('SIGKILL'));
}
