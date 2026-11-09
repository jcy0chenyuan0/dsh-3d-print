/**
 * Model-facing rendering helpers.
 *
 * A ToolDefinition's `output.render` must return ContentBlock[]. Only text
 * blocks are used here: they survive every client, they are what the model
 * reads, and they keep the results greppable in the session log.
 */

/** One text content block. */
export function text(value) {
	return { type: "text", text: String(value ?? "") };
}

/** Join several text fragments into one block list. */
export function blocks(...chunks) {
	return chunks.filter((chunk) => typeof chunk === "string" && chunk.length > 0).map((chunk) => text(chunk));
}

/** `12.34 mm` with a fixed number of decimals. */
export function mm(value, digits = 2) {
	if (!Number.isFinite(value)) return "—";
	return `${value.toFixed(digits)} mm`;
}

/** `54.1 cm³` */
export function cm3(value, digits = 2) {
	if (!Number.isFinite(value)) return "—";
	return `${value.toFixed(digits)} cm³`;
}

/** `12.3 cm²` */
export function cm2(value, digits = 2) {
	if (!Number.isFinite(value)) return "—";
	return `${value.toFixed(digits)} cm²`;
}

/** `3.4%` */
export function pct(value, digits = 1) {
	if (!Number.isFinite(value)) return "—";
	return `${value.toFixed(digits)}%`;
}

/** `✓` / `✗` / `…` */
export function mark(ok) {
	return ok === true ? "✓" : ok === false ? "✗" : "·";
}

/**
 * A markdown table. Cells are stringified; undefined becomes `—`.
 * @param {string[]} headers
 * @param {Array<Array<string|number|boolean|undefined>>} rows
 */
export function table(headers, rows) {
	const render = (cell) => (cell === undefined || cell === null ? "—" : String(cell));
	const width = headers.length;
	const lines = [`| ${headers.map(render).join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
	for (const row of rows) {
		const cells = row.slice(0, width);
		while (cells.length < width) cells.push("");
		lines.push(`| ${cells.map(render).join(" | ")} |`);
	}
	return lines.join("\n");
}

/** `key: value` lines, skipping undefined entries. */
export function keyValues(pairs) {
	return pairs
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([key, value]) => `- **${key}**: ${value}`)
		.join("\n");
}

/** A one-line verdict with a mark. */
export function verdict(ok, message) {
	return `${mark(ok)} ${message}`;
}

/** Truncate long process output for a model-facing report. */
export function tail(textValue, lines = 12) {
	const parts = String(textValue ?? "").replace(/\r/gu, "").split("\n").filter((line) => line.trim().length > 0);
	return parts.slice(-lines).join("\n");
}

/** Human byte size. */
export function bytes(value) {
	if (!Number.isFinite(value)) return "—";
	const units = ["B", "KiB", "MiB", "GiB"];
	let size = value;
	let index = 0;
	while (size >= 1024 && index < units.length - 1) {
		size /= 1024;
		index += 1;
	}
	return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
