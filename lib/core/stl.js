/**
 * Mesh I/O and geometric QA for the tools in this plugin.
 *
 * Everything here is plain JavaScript over typed arrays: the plugin must work in
 * a profile that has no Python, no numpy and no node_modules, so STL parsing,
 * volume, area, edge topology, overhang classification, orientation search and
 * bed fit are all computed locally.
 *
 * Conventions
 *   units   : millimetres throughout (STL is unitless; slicers treat it as mm)
 *   z       : "up" — the printer's +Z, i.e. the build direction
 *   theta   : inclination of a surface away from the horizontal plane,
 *             0° = horizontal (a flat ceiling or floor), 90° = vertical wall
 *   overhang: a *downward-facing* surface flatter than `overhangDeg`
 *             (default 45°). theta is derived from the outward normal n as
 *             theta = acos(-n.z), which equals 0° for a horizontal ceiling and
 *             90° for a vertical wall, so `theta < 45` is exactly the classic
 *             "needs support" test — do not invert it.
 */

/** Tolerance (mm) for welding vertices when rebuilding edge topology. */
const WELD_EPS = 1e-4;

/**
 * Read a binary or ASCII STL file into a flat vertex array.
 * @param {Buffer} buffer - whole file
 * @returns {{ triangles: number, verts: Float64Array, format: 'binary'|'ascii' }}
 */
export function parseStl(buffer) {
	if (buffer.length < 84) throw new Error("stl: file is too small to be an STL");
	const declared = buffer.readUInt32LE(80);
	if (declared > 0 && 84 + declared * 50 === buffer.length) return parseBinary(buffer, declared);
	const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString("latin1");
	if (head.trimStart().startsWith("solid")) {
		const ascii = parseAscii(buffer.toString("utf8"));
		if (ascii !== undefined) return ascii;
	}
	if (declared > 0 && buffer.length >= 84 + declared * 50) return parseBinary(buffer, declared);
	throw new Error("stl: neither a valid binary STL (length != 84 + 50*n) nor ASCII STL");
}

function parseBinary(buffer, triangles) {
	const verts = new Float64Array(triangles * 9);
	let offset = 84;
	for (let i = 0; i < triangles; i += 1) {
		offset += 12; // per-facet normal; recomputed from the winding instead
		for (let k = 0; k < 9; k += 1) {
			verts[i * 9 + k] = buffer.readFloatLE(offset);
			offset += 4;
		}
		offset += 2; // attribute byte count
	}
	return { triangles, verts, format: "binary" };
}

function parseAscii(text) {
	const matches = text.matchAll(/vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/gu);
	const values = [];
	for (const match of matches) {
		values.push(Number(match[1]), Number(match[2]), Number(match[3]));
		if (!Number.isFinite(values[values.length - 1])) return undefined;
	}
	if (values.length === 0 || values.length % 9 !== 0) return undefined;
	return { triangles: values.length / 9, verts: Float64Array.from(values), format: "ascii" };
}

/** Per-face unit normals, computed from the winding order (right-hand rule). */
export function faceNormals(verts, triangles) {
	const normals = new Float64Array(triangles * 3);
	for (let i = 0; i < triangles; i += 1) {
		const o = i * 9;
		const ax = verts[o], ay = verts[o + 1], az = verts[o + 2];
		const bx = verts[o + 3] - ax, by = verts[o + 4] - ay, bz = verts[o + 5] - az;
		const cx = verts[o + 6] - ax, cy = verts[o + 7] - ay, cz = verts[o + 8] - az;
		let nx = by * cz - bz * cy;
		let ny = bz * cx - bx * cz;
		let nz = bx * cy - by * cx;
		const len = Math.hypot(nx, ny, nz);
		if (len > 1e-12) {
			nx /= len;
			ny /= len;
			nz /= len;
		}
		normals[i * 3] = nx;
		normals[i * 3 + 1] = ny;
		normals[i * 3 + 2] = nz;
	}
	return normals;
}

function faceAreas(verts, triangles) {
	const areas = new Float64Array(triangles);
	for (let i = 0; i < triangles; i += 1) {
		const o = i * 9;
		const ax = verts[o], ay = verts[o + 1], az = verts[o + 2];
		const bx = verts[o + 3] - ax, by = verts[o + 4] - ay, bz = verts[o + 5] - az;
		const cx = verts[o + 6] - ax, cy = verts[o + 7] - ay, cz = verts[o + 8] - az;
		const nx = by * cz - bz * cy;
		const ny = bz * cx - bx * cz;
		const nz = bx * cy - by * cx;
		areas[i] = Math.hypot(nx, ny, nz) / 2;
	}
	return areas;
}

/** Axis-aligned bounds in mm. */
export function bounds(verts) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < verts.length; i += 3) {
		for (let k = 0; k < 3; k += 1) {
			const value = verts[i + k];
			if (value < min[k]) min[k] = value;
			if (value > max[k]) max[k] = value;
		}
	}
	return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Signed volume (mm^3) via the divergence theorem; positive for outward normals. */
export function signedVolume(verts, triangles) {
	let total = 0;
	for (let i = 0; i < triangles; i += 1) {
		const o = i * 9;
		const ax = verts[o], ay = verts[o + 1], az = verts[o + 2];
		const bx = verts[o + 3], by = verts[o + 4], bz = verts[o + 5];
		const cx = verts[o + 6], cy = verts[o + 7], cz = verts[o + 8];
		total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
	}
	return total / 6;
}

function weldKey(x, y, z) {
	return `${Math.round(x / WELD_EPS)},${Math.round(y / WELD_EPS)},${Math.round(z / WELD_EPS)}`;
}

/**
 * Edge topology: open edges mean the surface has a hole, an edge shared by more
 * than two triangles means the surface is non-manifold.
 */
export function edgeTopology(verts, triangles) {
	const keyToIndex = new Map();
	const ids = new Int32Array(triangles * 3);
	for (let i = 0; i < triangles; i += 1) {
		for (let k = 0; k < 3; k += 1) {
			const o = i * 9 + k * 3;
			const key = weldKey(verts[o], verts[o + 1], verts[o + 2]);
			let id = keyToIndex.get(key);
			if (id === undefined) {
				id = keyToIndex.size;
				keyToIndex.set(key, id);
			}
			ids[i * 3 + k] = id;
		}
	}
	const undirected = new Map();
	const directed = new Map();
	let degenerate = 0;
	for (let i = 0; i < triangles; i += 1) {
		const a = ids[i * 3], b = ids[i * 3 + 1], c = ids[i * 3 + 2];
		if (a === b || b === c || a === c) degenerate += 1;
		for (const [u, v] of [[a, b], [b, c], [c, a]]) {
			const lo = Math.min(u, v);
			const hi = Math.max(u, v);
			const key = lo * 4294967296 + hi;
			undirected.set(key, (undirected.get(key) ?? 0) + 1);
			const dkey = u * 4294967296 + v;
			directed.set(dkey, (directed.get(dkey) ?? 0) + 1);
		}
	}
	let openEdges = 0;
	let nonManifoldEdges = 0;
	for (const count of undirected.values()) {
		if (count === 1) openEdges += 1;
		else if (count > 2) nonManifoldEdges += 1;
	}
	let flippedEdges = 0;
	for (const count of directed.values()) if (count > 1) flippedEdges += 1;
	return {
		vertices: keyToIndex.size,
		openEdges,
		nonManifoldEdges,
		degenerate,
		flippedEdges,
		watertight: openEdges === 0 && nonManifoldEdges === 0,
		consistentWinding: flippedEdges === 0
	};
}

/** Number of connected shells, using vertex connectivity. */
export function shellCount(verts, triangles) {
	const keyToIndex = new Map();
	const parent = [];
	const find = (x) => {
		let root = x;
		while (parent[root] !== root) root = parent[root];
		while (parent[x] !== root) {
			const next = parent[x];
			parent[x] = root;
			x = next;
		}
		return root;
	};
	const union = (a, b) => {
		const ra = find(a), rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};
	const ids = new Int32Array(triangles * 3);
	for (let i = 0; i < triangles; i += 1) {
		for (let k = 0; k < 3; k += 1) {
			const o = i * 9 + k * 3;
			const key = weldKey(verts[o], verts[o + 1], verts[o + 2]);
			let id = keyToIndex.get(key);
			if (id === undefined) {
				id = keyToIndex.size;
				keyToIndex.set(key, id);
				parent.push(id);
			}
			ids[i * 3 + k] = id;
		}
		union(ids[i * 3], ids[i * 3 + 1]);
		union(ids[i * 3 + 1], ids[i * 3 + 2]);
	}
	const roots = new Set();
	for (let i = 0; i < triangles; i += 1) roots.add(find(ids[i * 3]));
	return roots.size;
}

/**
 * Classify every triangle by printability.
 *
 * @param {Float64Array} verts
 * @param {number} triangles
 * @param {{overhangDeg?: number, bedEps?: number}} [opts]
 * @returns overhang + bed-contact facts (areas in mm^2, see `toCm2` at call sites)
 */
export function surfaceStats(verts, triangles, opts = {}) {
	const overhangDeg = opts.overhangDeg ?? 45;
	const bedEps = opts.bedEps ?? 1.0;
	const normals = faceNormals(verts, triangles);
	const areas = faceAreas(verts, triangles);
	const box = bounds(verts);
	let area = 0;
	let overhangArea = 0;
	let overhangOnBed = 0;
	let horizontalDown = 0;
	let upwardArea = 0;
	let flatBottom = 0;
	const bands = new Map();
	const bandSize = 10;
	for (let i = 0; i < triangles; i += 1) {
		const a = areas[i];
		area += a;
		const nz = normals[i * 3 + 2];
		const centroidZ = (verts[i * 9 + 2] + verts[i * 9 + 5] + verts[i * 9 + 8]) / 3;
		const centroidX = (verts[i * 9] + verts[i * 9 + 3] + verts[i * 9 + 6]) / 3;
		const centroidY = (verts[i * 9 + 1] + verts[i * 9 + 4] + verts[i * 9 + 7]) / 3;
		void centroidX;
		void centroidY;
		if (nz > 0) upwardArea += a;
		if (nz < -1e-6) {
			const theta = Math.acos(Math.min(1, -nz)) * (180 / Math.PI);
			if (theta < 1e-6) horizontalDown += a;
			if (centroidZ - box.min[2] < bedEps) {
				overhangOnBed += a;
				if (theta < 1e-6) flatBottom += a;
			} else if (theta < overhangDeg - 1e-6) {
				overhangArea += a;
				const band = Math.floor((centroidZ - box.min[2]) / bandSize) * bandSize;
				bands.set(band, (bands.get(band) ?? 0) + a);
			}
		}
	}
	const byBand = [...bands.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([z0, value]) => ({ z0, z1: z0 + bandSize, areaCm2: value / 100 }));
	return {
		areaCm2: area / 100,
		overhangCm2: overhangArea / 100,
		overhangPercent: area > 0 ? (100 * overhangArea) / area : 0,
		overhangOnBedCm2: overhangOnBed / 100,
		horizontalDownCm2: horizontalDown / 100,
		flatBottomCm2: flatBottom / 100,
		upwardCm2: upwardArea / 100,
		overhangByBandCm2: byBand,
		overhangDeg
	};
}

/** Axis permutations used to search for a printable orientation. */
const ORIENTATIONS = (() => {
	const list = [];
	const perms = [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
	for (const perm of perms) {
		for (const s0 of [1, -1]) for (const s1 of [1, -1]) for (const s2 of [1, -1]) list.push([perm, [s0, s1, s2]]);
	}
	return list;
})();

/**
 * Find the orientation that minimises the footprint (and then height) on the bed.
 * Identity (no rotation) is returned when it already wins.
 * @returns {{perm: number[], sign: number[], footprintMm2: number, heightMm: number, label: string}}
 */
export function bestOrientation(verts) {
	const box = bounds(verts);
	const size = box.size;
	let best = { perm: [0, 1, 2], sign: [1, 1, 1], footprintMm2: size[0] * size[1], heightMm: size[2] };
	for (const [perm, sign] of ORIENTATIONS) {
		const sx = size[perm[0]];
		const sy = size[perm[1]];
		const sz = size[perm[2]];
		const footprint = sx * sy;
		const better = footprint < best.footprintMm2 * 0.999 ||
			(Math.abs(footprint - best.footprintMm2) <= best.footprintMm2 * 0.001 && sz < best.heightMm);
		if (better) best = { perm, sign, footprintMm2: footprint, heightMm: sz };
	}
	const axisName = (index) => "XYZ"[index];
	const label = `${["X", "Y", "Z"].map((name, i) => `${name}<-${axisName(best.perm[i])}`).join(" ")}`;
	return { ...best, label };
}

/**
 * Whether the part fits a printer's printable volume, in the given orientation.
 * @param {{min:number[], max:number[], size:number[]}} box
 * @param {{x:number,y:number,z:number}} bed
 */
export function bedFit(box, bed) {
	const fits = box.size[0] <= bed.x + 1e-6 && box.size[1] <= bed.y + 1e-6 && box.size[2] <= bed.z + 1e-6;
	const fitsRotatedZ = box.size[1] <= bed.x + 1e-6 && box.size[0] <= bed.y + 1e-6 && box.size[2] <= bed.z + 1e-6;
	return {
		fits,
		fitsAfterSwapXY: fitsRotatedZ,
		overflowMm: [Math.max(0, box.size[0] - bed.x), Math.max(0, box.size[1] - bed.y), Math.max(0, box.size[2] - bed.z)]
	};
}

/** Full report for one mesh. */
export function analyzeStl(buffer, opts = {}) {
	const parsed = parseStl(buffer);
	const { verts, triangles } = parsed;
	const normals = faceNormals(verts, triangles);
	void normals;
	const box = bounds(verts);
	const rawVolume = signedVolume(verts, triangles);
	const topo = edgeTopology(verts, triangles);
	const shells = shellCount(verts, triangles);
	const surface = surfaceStats(verts, triangles, opts);
	const volumeCm3 = Math.abs(rawVolume) / 1000;
	return {
		format: parsed.format,
		triangles,
		vertices: topo.vertices,
		/** raw vertex array, kept for orientation search and callers that re-analyse */
		verts,
		volumeCm3,
		volumePositive: rawVolume > 0,
		areaCm2: surface.areaCm2,
		bbox: box,
		topology: topo,
		shells,
		surface,
		/** crude "is this a printable solid" verdict, refined by callers */
		looksPrintable: topo.watertight && topo.consistentWinding && volumeCm3 > 1e-6,
		/** area-weighted mean thickness estimate: 2V/A, a lower bound for a thin plate */
		meanThicknessMm: surface.areaCm2 > 0 ? (2 * volumeCm3 * 1000) / (surface.areaCm2 * 100) : 0
	};
}

export const STL_HELP = "Only STL is parsed locally; convert 3MF/OBJ to STL first (or use the slicer).";
