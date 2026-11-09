/**
 * Path resolution shared by every tool.
 *
 * Model-facing arguments are always relative to the session workspace, and a
 * `..` escape is rejected instead of being clipped: a tool that silently writes
 * somewhere else is worse than one that fails.
 */
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** The directory a call is anchored to. */
export function workspaceOf(exec, fallback) {
	return exec?.agent?.session?.header?.cwd ?? fallback ?? process.cwd();
}

export function createPaths(settings) {
	/** Resolve `requested` against the session workspace, refusing escapes. */
	function inside(exec, requested) {
		const anchor = workspaceOf(exec, settings.cwd);
		if (requested === undefined || requested === null || requested === "") return anchor;
		const resolved = isAbsolute(requested) ? resolve(requested) : resolve(anchor, requested);
		const rel = relative(anchor, resolved);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`invalid path: "${requested}" escapes the session workspace (${anchor})`);
		return resolved;
	}

	/** The plugin's own output root inside the workspace. */
	function outRoot(exec) {
		const anchor = workspaceOf(exec, settings.cwd);
		return join(anchor, settings.outDir);
	}

	/** `<workspace>/<outDir>/<...parts>`, created on demand. */
	function out(exec, ...parts) {
		const dir = join(outRoot(exec), ...parts);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	/** A relative, human-readable form of an absolute path (for messages). */
	function display(exec, absolute) {
		const anchor = workspaceOf(exec, settings.cwd);
		const rel = relative(anchor, absolute);
		return rel.length === 0 ? "." : rel.split(sep).join("/");
	}

	return { inside, out, outRoot, display, workspaceOf: (exec) => workspaceOf(exec, settings.cwd) };
}

/** Is this path an existing directory? */
export function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A filesystem-safe stem for derived file names. */
export function stem(name, fallback = "model") {
	const base = (name ?? "").split(/[\\/]/u).pop() ?? "";
	const cleaned = base.replace(/\.[^.]+$/u, "").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return cleaned.length > 0 ? cleaned : fallback;
}
