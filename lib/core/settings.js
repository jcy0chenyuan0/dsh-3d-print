/**
 * Plugin settings: documented defaults, and validation loud enough that a typo
 * in `cordis.patch.yml` fails at activation instead of at the first render.
 */

export const DEFAULTS = {
	/** Where renders and previews are written, relative to the session workspace. */
	outDir: "3dprint",
	/** Default printer id from core/printers.js (bed size, nozzle, family). */
	printer: "creality-hi",
	/** Explicit tool paths; empty means "discover". */
	openscadPath: "",
	blenderPath: "",
	/** OpenSCAD renders are slow; 10 min covers a 1M-triangle $fn=200 model. */
	renderTimeoutMs: 600_000,
	/** Slicing a large model can take longer still. */
	sliceTimeoutMs: 1_800_000,
	/** Generic external command deadline. */
	timeoutMs: 300_000,
	graceMs: 3_000,
	maxOutputBytes: 200_000,
	/** PNG preview defaults. */
	previewSize: "1600,1200",
	previewCamera: "0,0,0,55,0,25,0",
	/** Classify a downward face flatter than this as an overhang. */
	overhangDeg: 45,
	/** Faces within this height of the bed are "resting on the bed", not overhangs. */
	bedEps: 1.0,
	/** Let print3d_setup install OpenSCAD without asking again. */
	autoInstall: true
};

function requireText(key, value) {
	if (typeof value !== "string") throw new Error(`dsh-3d-print: config.${key} must be a string`);
	return value.trim();
}

function requireNumber(key, value, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
	if (!Number.isFinite(value) || value < min || value > max) throw new Error(`dsh-3d-print: config.${key} must be a number between ${min} and ${max}`);
	return value;
}

/** Validate a raw patch config against the defaults. */
export function normalizeConfig(config = {}) {
	const merged = { ...DEFAULTS, ...config };
	const settings = {
		outDir: requireText("outDir", merged.outDir) || DEFAULTS.outDir,
		printer: requireText("printer", merged.printer) || DEFAULTS.printer,
		openscadPath: requireText("openscadPath", merged.openscadPath),
		blenderPath: requireText("blenderPath", merged.blenderPath),
		renderTimeoutMs: requireNumber("renderTimeoutMs", merged.renderTimeoutMs, { min: 1_000 }),
		sliceTimeoutMs: requireNumber("sliceTimeoutMs", merged.sliceTimeoutMs, { min: 1_000 }),
		timeoutMs: requireNumber("timeoutMs", merged.timeoutMs, { min: 1_000 }),
		graceMs: requireNumber("graceMs", merged.graceMs, { min: 0 }),
		maxOutputBytes: requireNumber("maxOutputBytes", merged.maxOutputBytes, { min: 1_024 }),
		previewSize: requireText("previewSize", merged.previewSize),
		previewCamera: requireText("previewCamera", merged.previewCamera),
		overhangDeg: requireNumber("overhangDeg", merged.overhangDeg, { min: 1, max: 89 }),
		bedEps: requireNumber("bedEps", merged.bedEps, { min: 0 }),
		autoInstall: merged.autoInstall === true
	};
	if (settings.outDir.startsWith("/") || settings.outDir.includes("..")) throw new Error("dsh-3d-print: config.outDir must be a relative path inside the workspace");
	return settings;
}
