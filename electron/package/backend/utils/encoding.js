import iconv from 'iconv-lite';

const XML_ENCODING_REGEX = /<\?xml[^>]*encoding=["']([^"']+)["'][^>]*\?>/i;

export function detectEncoding(contentType, xmlSnippet) {
  if (contentType) {
    const match = contentType.match(/charset=([^;]+)/i);
    if (match && match[1]) return match[1].trim().toLowerCase();
  }
  if (xmlSnippet) {
    const match = xmlSnippet.match(XML_ENCODING_REGEX);
    if (match && match[1]) return match[1].trim().toLowerCase();
  }
  return 'utf-8';
}

export function decodeBuffer(buffer, encoding) {
  try {
    return iconv.decode(Buffer.from(buffer), encoding || 'utf-8');
  } catch {
    return Buffer.from(buffer).toString('utf-8');
  }
}
