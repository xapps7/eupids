// NFR Observability: structured JSON logs, one line per event, always with shopId where known.
type Fields = Record<string, unknown>;
const emit = (level: string, event: string, fields: Fields) => {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  console.log(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }));
};
export const log = {
  info: (e: string, f: Fields = {}) => emit("info", e, f),
  warn: (e: string, f: Fields = {}) => emit("warn", e, f),
  error: (e: string, f: Fields = {}) => emit("error", e, f),
};
