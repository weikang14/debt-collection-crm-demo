// Logo upload constraints + data-URL encoding, shared by the settings route's
// multer config and its POST handler. Stored as a data: URL in the DB so it
// travels with backups and embeds directly when the statement is printed.
const LOGO_MIME = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const MAX_LOGO_BYTES = 512 * 1024;

function toDataUrl(mimetype, buffer) {
  return `data:${mimetype};base64,${buffer.toString('base64')}`;
}

module.exports = { LOGO_MIME, MAX_LOGO_BYTES, toDataUrl };
