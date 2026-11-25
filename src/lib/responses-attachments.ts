import { inflateSync } from "node:zlib";
import { invalidResponseRequest, responseObject, responseText, type ResponseObject as Obj } from "./responses-http";

const MAX_ATTACHMENT = 8 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const textExtensions = /\.(?:c|cc|cfg|conf|cpp|cs|css|csv|go|h|html|java|js|json|jsx|log|md|php|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i;
function decodeDataURL(value: string) {
  const match = /^data:([^,]*?),(.*)$/s.exec(value);
  if (!match) return null;
  const [metadata, data] = match;
  const mime = metadata.split(";", 1)[0].toLowerCase();
  try { return { mime, bytes: metadata.split(";").includes("base64") ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data)) }; }
  catch { return null; }
}

function encoded(value: string) {
  const data = decodeDataURL(value);
  if (data) return data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) {
    invalidResponseRequest("Inline attachment data must be base64 or a data URL.", "input.file_data");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length && value) invalidResponseRequest("Inline attachment data is not valid base64.", "input.file_data");
  return { mime: "", bytes };
}

function remoteURL(value: string, param: string) {
  let url: URL;
  try { url = new URL(value); } catch { invalidResponseRequest("Attachment URL must be absolute.", param); }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password) {
    invalidResponseRequest("Attachment URLs must use HTTPS (HTTP is accepted for loopback testing).", param);
  }
  return url;
}

async function fetchAttachment(value: string, param: string) {
  const url = remoteURL(value, param);
  let response: Response;
  try { response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), cache: "no-store" }); }
  catch { invalidResponseRequest("The remote attachment could not be downloaded.", param); }
  if (!response.ok) invalidResponseRequest(`The remote attachment returned HTTP ${response.status}.`, param);
  if (Number(response.headers.get("content-length")) > MAX_ATTACHMENT) {
    void response.body?.cancel().catch(() => undefined);
    invalidResponseRequest("The remote attachment exceeds 8 MiB.", param);
  }
  const reader = response.body?.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ATTACHMENT) invalidResponseRequest("The remote attachment exceeds 8 MiB.", param);
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks, size);
  if (bytes.byteLength > MAX_ATTACHMENT) invalidResponseRequest("The remote attachment exceeds 8 MiB.", param);
  return { bytes, mime: (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() };
}

function pdfStrings(raw: string) {
  let result = "";
  for (const match of raw.matchAll(/\(((?:\\.|[^\\)])*)\)|<([A-Fa-f0-9\s]+)>/g)) {
    if (match[2]) {
      const hex = match[2].replace(/\s/g, "");
      const bytes = Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex");
      result += bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff
        ? bytes.subarray(2).swap16().toString("utf16le") : bytes.toString("latin1");
      continue;
    }
    let value = match[1] ?? "";
    value = value.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_all, code: string) => {
      if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[code] ?? (code.startsWith("\n") || code.startsWith("\r") ? "" : code);
    });
    result += value;
  }
  return result;
}

// Small dependency-free extractor for ordinary text PDFs. Image-only scans need
// OCR and produce a clear error rather than an invented transcription.
export function pdfText(bytes: Buffer) {
  const source = bytes.toString("latin1");
  const sections: string[] = [];
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const header = source.slice(Math.max(0, (match.index ?? 0) - 500), match.index);
    let data = Buffer.from(match[1], "latin1");
    try {
      if (/\/FlateDecode/.test(header)) data = inflateSync(data);
      else if (/\/ASCII85Decode/.test(header)) {
        const encoded85 = data.toString("latin1").replace(/^<~|~>$/g, "").trim();
        // Most PDF producers use Flate; preserve explicit handling for uncompressed
        // streams instead of passing compressed bytes into the text parser.
        if (encoded85) continue;
      } else if (/\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/Image/.test(header)) continue;
      const content = data.toString("latin1");
      if (!/\b(?:BT|Tj|TJ)\b/.test(content)) continue;
      const lines: string[] = [];
      for (const block of content.matchAll(/BT([\s\S]*?)ET/g)) {
        const fragments = [...block[1].matchAll(/((?:\((?:\\.|[^\\)])*\)|<[A-Fa-f0-9\s]+>|\[[^\]]*\])\s*Tj|(\[[\s\S]*?\])\s*TJ)/g)];
        for (const fragment of fragments) lines.push(pdfStrings(fragment[1] || fragment[2] || ""));
      }
      if (lines.some((line) => line.trim())) sections.push(lines.join("\n"));
    } catch { /* Skip malformed individual streams and use remaining pages. */ }
  }
  return sections.join("\n\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
}

function attachmentText(bytes: Buffer, mime: string, filename: string, param: string) {
  const isPDF = mime === "application/pdf" || /\.pdf$/i.test(filename) || bytes.subarray(0, 5).toString() === "%PDF-";
  if (isPDF) {
    const text = pdfText(bytes);
    if (!text) invalidResponseRequest("This PDF has no extractable text (it may be a scanned document).", param);
    return text;
  }
  if (mime && !mime.startsWith("text/") && !/(?:json|xml|javascript|yaml|x-sh|plain)/.test(mime)
      && !textExtensions.test(filename) && bytes.includes(0)) {
    invalidResponseRequest(`Attachment type ${mime || "unknown"} cannot be converted to text by the Chat bridge; convert it to text first.`, param);
  }
  const text = bytes.toString("utf8");
  if (!text.trim()) invalidResponseRequest("The text attachment is empty.", param);
  return text;
}

export async function expandAttachments(input: Obj[]) {
  let textBudget = MAX_TEXT;
  async function visit(value: unknown, param: string): Promise<unknown> {
    if (!Array.isArray(value)) return value;
    const output: unknown[] = [];
    for (const [index, raw] of value.entries()) {
      const part = responseObject(raw);
      const path = `${param}[${index}]`;
      const type = part.type;
      const inlineImage = type === "input_image" && (part.file_id != null || part.file_data != null || part.image_data != null);
      if (type !== "input_file" && type !== "input_audio" && !inlineImage) {
        output.push(raw);
        continue;
      }
      const inline = responseText(part.file_data ?? part.audio_data ?? part.data ?? part.image_url ?? part.image_data);
      const url = responseText(part.file_url ?? part.audio_url);
      const filename = responseText(part.filename ?? part.name);
      if (!inline && !url) {
        invalidResponseRequest("This attachment needs file_data, data, or an HTTPS file_url; standalone file_id values are resolved only by an upstream Files API.", path);
      }
      const source = inline ? encoded(inline) : await fetchAttachment(url, path);
      if (source.bytes.byteLength > MAX_ATTACHMENT) invalidResponseRequest("The attachment exceeds 8 MiB.", path);
      const mime = responseText(part.mime_type ?? part.media_type).toLowerCase() || source.mime;
      const image = (type === "input_image" || mime.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)$/i.test(filename))
        && type !== "input_audio";
      if (image) {
        if (!mime.startsWith("image/")) invalidResponseRequest("An image attachment needs an image MIME type.", path);
        if (!source.bytes.length) invalidResponseRequest("The image attachment is empty.", path);
        if (mime === "image/png" && !source.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          invalidResponseRequest("The PNG attachment has invalid content.", path);
        }
        if ((mime === "image/jpeg" || mime === "image/jpg") && !source.bytes.subarray(0, 2).equals(Buffer.from([255, 216]))) {
          invalidResponseRequest("The JPEG attachment has invalid content.", path);
        }
        output.push({ type: "input_image", image_url: `data:${mime};base64,${source.bytes.toString("base64")}`, ...(part.detail == null ? {} : { detail: part.detail }) });
        continue;
      }
      if (type === "input_audio") invalidResponseRequest("Audio transcription is not available on the Chat bridge; send a transcript as text.", path);
      const text = attachmentText(source.bytes, mime, filename, path);
      if (text.length > textBudget) invalidResponseRequest("Extracted attachment text exceeds the 1 MiB per-request budget.", path);
      textBudget -= text.length;
      output.push({ type: "input_text", text: `Attachment ${filename || "file"} (${mime || "text"}):\n${text}` });
    }
    return output;
  }
  for (const [index, original] of input.entries()) {
    const item = { ...original };
    if (Array.isArray(item.content)) item.content = await visit(item.content, `input[${index}].content`);
    if (Array.isArray(item.output)) item.output = await visit(item.output, `input[${index}].output`);
    if (Array.isArray(item.input)) item.input = await visit(item.input, `input[${index}].input`);
    input[index] = item;
  }
  return input;
}
