/**
 * Printer presets.
 *
 * Bed size is the only thing the geometry tools need, but a preset also carries
 * the slicer family and process hints so `print3d_slice` can pick a matching
 * config instead of guessing. Dimensions are the *printable* volume in mm, not
 * the machine's external size.
 */

/** @typedef {{id: string, name: string, family: string, bed: {x: number, y: number, z: number}, nozzle: number, notes?: string}} PrinterProfile */

/** @type {Record<string, PrinterProfile>} */
export const PRINTERS = {
	"creality-hi": { id: "creality-hi", name: "Creality Hi", family: "creality", bed: { x: 260, y: 260, z: 300 }, nozzle: 0.4 },
	"creality-k1": { id: "creality-k1", name: "Creality K1", family: "creality", bed: { x: 220, y: 220, z: 250 }, nozzle: 0.4 },
	"creality-k1-max": { id: "creality-k1-max", name: "Creality K1 Max", family: "creality", bed: { x: 300, y: 300, z: 300 }, nozzle: 0.4 },
	"creality-k2-plus": { id: "creality-k2-plus", name: "Creality K2 Plus", family: "creality", bed: { x: 350, y: 350, z: 350 }, nozzle: 0.4 },
	"creality-ender3": { id: "creality-ender3", name: "Creality Ender-3", family: "creality", bed: { x: 220, y: 220, z: 250 }, nozzle: 0.4 },
	"creality-ender5": { id: "creality-ender5", name: "Creality Ender-5", family: "creality", bed: { x: 220, y: 220, z: 300 }, nozzle: 0.4 },

	"bambu-a1": { id: "bambu-a1", name: "Bambu Lab A1", family: "bambu", bed: { x: 256, y: 256, z: 256 }, nozzle: 0.4 },
	"bambu-a1-mini": { id: "bambu-a1-mini", name: "Bambu Lab A1 mini", family: "bambu", bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4 },
	"bambu-p1s": { id: "bambu-p1s", name: "Bambu Lab P1S", family: "bambu", bed: { x: 256, y: 256, z: 256 }, nozzle: 0.4 },
	"bambu-x1c": { id: "bambu-x1c", name: "Bambu Lab X1 Carbon", family: "bambu", bed: { x: 256, y: 256, z: 256 }, nozzle: 0.4 },

	"prusa-mk4": { id: "prusa-mk4", name: "Prusa MK4 / MK4S", family: "prusa", bed: { x: 250, y: 210, z: 220 }, nozzle: 0.4 },
	"prusa-mini": { id: "prusa-mini", name: "Prusa MINI+", family: "prusa", bed: { x: 180, y: 180, z: 180 }, nozzle: 0.4 },
	"prusa-core-one": { id: "prusa-core-one", name: "Prusa CORE One", family: "prusa", bed: { x: 250, y: 220, z: 270 }, nozzle: 0.4 },

	"voron-0": { id: "voron-0", name: "Voron 0.2", family: "voron", bed: { x: 120, y: 120, z: 120 }, nozzle: 0.4 },
	"voron-2-350": { id: "voron-2-350", name: "Voron 2.4 350", family: "voron", bed: { x: 350, y: 350, z: 330 }, nozzle: 0.4 },

	"anycubic-kobra2": { id: "anycubic-kobra2", name: "Anycubic Kobra 2", family: "anycubic", bed: { x: 220, y: 220, z: 250 }, nozzle: 0.4 },
	"elegoo-neptune4": { id: "elegoo-neptune4", name: "Elegoo Neptune 4", family: "elegoo", bed: { x: 235, y: 235, z: 265 }, nozzle: 0.4 },
	"sovol-sv06": { id: "sovol-sv06", name: "Sovol SV06", family: "sovol", bed: { x: 220, y: 220, z: 250 }, nozzle: 0.4 },

	generic: { id: "generic", name: "通用 200³", family: "generic", bed: { x: 200, y: 200, z: 200 }, nozzle: 0.4, notes: "未知机型时的保守兜底" }
};

/** Every preset as a stable, sorted array. */
export function listPrinters() {
	return Object.values(PRINTERS).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Look a printer up by id, or fall back to the configured default.
 * @param {string|undefined} id
 * @param {string} fallbackId
 */
export function resolvePrinter(id, fallbackId = "creality-hi") {
	const key = (id ?? fallbackId).trim().toLowerCase();
	const direct = PRINTERS[key];
	if (direct !== undefined) return direct;
	const byName = listPrinters().find((printer) => printer.name.toLowerCase() === key);
	if (byName !== undefined) return byName;
	throw new Error(`未知机型 "${id}"。可用：${listPrinters().map((printer) => printer.id).join(", ")}`);
}

/** Nozzle-derived process hints that show up in QA reports. */
export function processHints(printer, nozzleOverride) {
	const nozzle = nozzleOverride ?? printer.nozzle;
	return {
		nozzle,
		layerHeight: Number((nozzle * 0.5).toFixed(2)),
		wallWidth: nozzle,
		/** 3 walls + 4 top/bottom is the usual "structural" starting point. */
		wallCount: 3,
		minFeatureMm: Number((nozzle * 2).toFixed(2)),
		minHoleMm: Number((nozzle * 1.5).toFixed(2))
	};
}
