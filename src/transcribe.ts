import { config } from './config';

export async function transcribeAudio(
  audioBuffer: ArrayBuffer,
  filename: string = 'voice.ogg',
): Promise<string> {
  const apiKey = config.openaiApiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — cannot transcribe voice notes');
  }

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), filename);
  form.append('model', 'whisper-1');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${text}`);
  }

  const data = await response.json() as { text: string };
  return data.text.trim();
}
