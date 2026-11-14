/**
 * Largest MP3 that is returned inline as an MCP audio block. Base64 adds a third on top, and many clients cap
 * tool results — long scripts stay on disk only and the JSON says why.
 */
export const MAX_EMBED_AUDIO_BYTES = 8 * 1024 * 1024;
/**
 * Tool result for a written MP3: the JSON summary as text, plus the audio itself as an MCP audio block when
 * embedding is on and the file is small enough. Clients without access to the server's disk (containers, remote
 * agents) can then attach or play the audio; the file path stays in the JSON either way.
 */
export function audioResult(payload, audio, embed, mimeType = 'audio/mpeg') {
    // The Content-Type from Telnyx may carry parameters ("audio/mpeg; charset=…") or be missing
    // (application/octet-stream) — clients map the bare audio type to a file extension.
    const bare = mimeType.split(';')[0].trim().toLowerCase();
    const audioType = bare.startsWith('audio/') ? bare : 'audio/mpeg';
    const fits = audio.length <= MAX_EMBED_AUDIO_BYTES;
    const embedded = embed && fits;
    const summary = {
        ...payload,
        audio_embedded: embedded,
        ...(embed && !fits
            ? {
                audio_note: `Audio not embedded: ${audio.length} bytes exceed the inline limit of ${MAX_EMBED_AUDIO_BYTES} bytes. Use file_path.`,
            }
            : {}),
    };
    const content = [
        { type: 'text', text: JSON.stringify(summary, null, 2) },
    ];
    if (embedded) {
        content.push({ type: 'audio', data: audio.toString('base64'), mimeType: audioType });
    }
    return { content };
}
