/**
 * Coarse format label for the anonymous `file_redacted` analytics event. Maps a filename to a small,
 * fixed bucket so the usage dashboard breaks redactions down by type (pdf / xlsx / csv / docx / txt /
 * other). It is derived ONLY from the extension — never the filename body — so nothing identifying is
 * ever sent. A scanned PDF ("scan") and a pasted-text redaction ("text") are labelled at their own call
 * sites, not here.
 */
export function redactFormat(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "pdf":
      return "pdf";
    case "xlsx":
    case "xls":
      return "xlsx";
    case "csv":
      return "csv";
    case "docx":
    case "doc":
      return "docx";
    case "txt":
      return "txt";
    default:
      return "other";
  }
}
