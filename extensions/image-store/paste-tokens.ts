import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTokensAtomic } from "./atomic";
import { DEFAULT_SETTINGS, hexForeground, MAX_ROWS, MIN_ROWS, parseColor, parseRows, readSettings, thumbnailRows, writeSettings, type PreviewSettings } from "./config";
import type { StoredImageRef } from "./index";
import { bracketedPasteContent, imageToken, parsePastedImages, PASTE_END, PASTE_START, PI_CLIPBOARD_PATH, referencedLabels } from "./paste";
import { ThumbnailStrip, type ImageSource, type StripItem } from "./strip";
import { ImageViewer, type ViewerItem } from "./viewer";

export const PASTE_USAGE = `view | preview on|off | rows auto|${MIN_ROWS}-${MAX_ROWS} | color <theme color|#rrggbb> | settings`;
export const PASTE_COMPLETIONS = ["view", "preview on", "preview off", "rows auto", "rows 4", "rows 8", "color warning", "color accent", "settings"];

interface DraftImage {
	label: number;
	ref?: StoredImageRef;
	/** The pasted file's bytes as base64, read once at paste time. */
	data?: string;
	failed?: boolean;
	/** Settles once the file has been read, or failed to. */
	ready: Promise<void>;
}

/**
 * Pasted image paths show as `[Image N]` tokens with thumbnails above the
 * editor and a full-screen viewer. On submit, the tokens stay in the text and
 * their images are attached, so image-store stores and previews them like any
 * other pasted image.
 */
export function createPasteTokens(pi: ExtensionAPI, agentDirectory: string) {
	const settingsPath = join(agentDirectory, "image-store.json");
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let draft = new Map<number, DraftImage>();
	let nextLabel = 1;
	let viewerOpen = false;
	let normalizing = false;
	let settings: PreviewSettings = { ...DEFAULT_SETTINGS };
	/** Draft images by digest, for thumbnails and the viewer. */
	const source: ImageSource = {
		load: async (image) => {
			const data = [...draft.values()].find((item) => item.ref?.digest === image.digest)?.data;
			if (data === undefined) throw new Error("Pasted image is no longer in the prompt");
			return data;
		},
	};

	const requestRender = () => tui?.requestRender();
	const rows = () => thumbnailRows(settings.previewRows, tui?.terminal.rows ?? 24);
	const tokenBehavior = {
		isLive: (label: number) => draft.has(label),
		// A pasted-content block: bold terminal-background text on the token color.
		highlight: (token: string) => {
			const theme = ctx?.ui.theme;
			if (!theme) return token;
			const color = settings.tokenColor;
			let colored: string;
			if (color.startsWith("#")) colored = `${hexForeground(color)}${token}\x1b[39m`;
			else {
				try {
					colored = theme.fg(color as ThemeColor, token);
				} catch {
					colored = theme.fg("warning", token);
				}
			}
			return theme.bold(theme.inverse(colored));
		},
	};

	const resetDraft = () => {
		draft = new Map();
		nextLabel = 1;
	};

	/** Draft images still referenced by the editor text, ordered by label. */
	const referencedDraft = (text: string) => referencedLabels(text)
		.filter((label) => draft.has(label))
		.sort((a, b) => a - b)
		.map((label) => draft.get(label)!);

	/**
	 * A paste into an editor that shows no draft token starts a new draft.
	 * Never reset on an empty editor: submitting clears it before the input
	 * event expands the tokens.
	 */
	const resetAbandonedDraft = (text: string) => {
		if (draft.size && !referencedDraft(text).length) resetDraft();
	};

	const addDraft = (path: string, mimeType: string): number => {
		const label = nextLabel++;
		const item: DraftImage = { label, ready: Promise.resolve() };
		draft.set(label, item);
		item.ready = readFile(path).then(
			(bytes) => {
				item.data = bytes.toString("base64");
				item.ref = { digest: createHash("sha256").update(bytes).digest("hex"), mimeType, bytes: bytes.length };
				requestRender();
			},
			() => {
				item.failed = true;
				requestRender();
			},
		);
		return label;
	};

	/** Show images full-screen; the prompt's thumbnails hide meanwhile, so they never overlap it. */
	const show = async (items: ViewerItem[], start: number, images: ImageSource) => {
		if (!ctx?.hasUI || viewerOpen || !items.length) return;
		viewerOpen = true;
		requestRender();
		try {
			await ctx.ui.custom<void>((viewTui, theme, _keys, done) => new ImageViewer(items, start, images, theme, viewTui, () => done()));
		} finally {
			viewerOpen = false;
			requestRender();
		}
	};

	const openViewer = async (digest?: string) => {
		if (!ctx) return;
		const items = referencedDraft(ctx.ui.getEditorText())
			.filter((item) => item.ref)
			.map((item) => ({ caption: imageToken(item.label), image: item.ref! }));
		if (!items.length) {
			ctx.ui.notify("No pasted images in the prompt. Paste an image path or screenshot into the editor.", "info");
			return;
		}
		const index = items.findIndex((item) => item.image.digest === digest);
		await show(items, index >= 0 ? index : items.length - 1, source);
	};

	/** Pi's own Ctrl+V inserts a temporary file path; turn it into a token like pasted paths. */
	const normalizePiClipboardPaths = (text: string) => {
		if (normalizing || !ctx || !PI_CLIPBOARD_PATH.test(text)) return;
		PI_CLIPBOARD_PATH.lastIndex = 0;
		normalizing = true;
		queueMicrotask(() => {
			normalizing = false;
			if (!ctx) return;
			const current = ctx.ui.getEditorText();
			resetAbandonedDraft(current);
			const next = current.replace(PI_CLIPBOARD_PATH, (path) => {
				const mimeType = parsePastedImages(path, ctx!.cwd)?.[0]?.mimeType;
				return mimeType ? imageToken(addDraft(path, mimeType)) : path;
			});
			if (next !== current) ctx.ui.setEditorText(next);
		});
	};

	class DraftWidget implements Component {
		private strip?: ThumbnailStrip;
		private signature = "";

		constructor(private readonly theme: Theme) {}

		render(width: number): string[] {
			if (!ctx || viewerOpen) return [];
			const text = ctx.ui.getEditorText();
			normalizePiClipboardPaths(text);
			if (!settings.preview) return [];
			const items: StripItem[] = referencedDraft(text).map((item) => ({ label: item.label, image: item.ref, failed: item.failed }));
			const signature = items.map((item) => `${item.label}:${item.image?.digest ?? (item.failed ? "x" : "…")}`).join(",");
			if (signature !== this.signature || !this.strip) {
				this.signature = signature;
				this.strip = new ThumbnailStrip(items, source, this.theme, {
					rows,
					requestRender,
					onOpen: (index) => void openViewer(items[index]?.image?.digest),
				});
			}
			return this.strip.render(width);
		}

		handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
			return this.strip?.handleMouse(event);
		}

		invalidate(): void {
			this.strip = undefined;
		}
	}

	pi.on("session_start", (_event, context) => {
		ctx = context;
		settings = readSettings(settingsPath);
		resetDraft();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (!context.hasUI || context.mode !== "tui") return;
		context.ui.setWidget("image-store-paste", (widgetTui, theme) => {
			tui = widgetTui;
			return new DraftWidget(theme);
		}, { placement: "aboveEditor" });
		unsubscribeInput = context.ui.onTerminalInput((data) => {
			// Runs before the editor sees the key, so tokens are atomic before the first one is inserted.
			// Pi's TUI class exposes the focused editor, though its TUI interface does not declare it.
			const focused = (tui as { getFocusedComponent?: () => Component | null } | undefined)?.getFocusedComponent?.();
			if (focused && "getCursor" in focused) makeTokensAtomic(focused, tokenBehavior);
			const content = bracketedPasteContent(data);
			if (content === undefined) return undefined;
			// Bash mode keeps literal paths for shell commands.
			if (context.ui.getEditorText().trimStart().startsWith("!")) return undefined;
			const images = parsePastedImages(content, context.cwd);
			if (!images) return undefined;
			resetAbandonedDraft(context.ui.getEditorText());
			const tokens = images.map((image) => imageToken(addDraft(image.path, image.mimeType)));
			return { data: `${PASTE_START}${tokens.join(" ")} ${PASTE_END}` };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		ctx = undefined;
		tui = undefined;
		resetDraft();
	});

	// Registered before image-store's own input handler, which then stores the attachments.
	pi.on("input", async (event, context) => {
		if (!draft.size) return;
		const items = referencedDraft(event.text);
		resetDraft();
		if (!items.length) return;
		await Promise.all(items.map((item) => item.ready));
		const images: ImageContent[] = items
			.filter((item) => item.ref && item.data !== undefined)
			.map((item) => ({ type: "image", data: item.data!, mimeType: item.ref!.mimeType }));
		const missing = items.length - images.length;
		if (missing) context.ui.notify(`${missing} pasted image${missing === 1 ? " was" : "s were"} unavailable and not sent.`, "warning");
		if (!images.length) return;
		return { action: "transform" as const, text: event.text, images: [...event.images ?? [], ...images] };
	});

	pi.registerShortcut("alt+i", {
		description: "View pasted images in the prompt",
		handler: async () => {
			await openViewer();
		},
	});

	const describeSettings = () => {
		const size = settings.previewRows === "auto" ? `auto (${rows()})` : String(settings.previewRows);
		return `Image previews ${settings.preview ? "on" : "off"} · rows ${size} · token color ${settings.tokenColor}`;
	};

	/** Handle a paste subcommand of `/image-store`; false when the action is not one. */
	const command = async (args: string, context: ExtensionContext): Promise<boolean> => {
		const [rawKey = "", rawValue, extra] = args.trim().split(/\s+/);
		const key = rawKey.toLowerCase();
		const value = rawValue?.toLowerCase();
		if (key === "view") {
			await openViewer();
			return true;
		}
		if (key === "settings" && !value) {
			context.ui.notify(describeSettings(), "info");
			return true;
		}
		if (!["preview", "rows", "color"].includes(key)) return false;
		let update: Partial<PreviewSettings> | undefined;
		if (extra === undefined && key === "preview" && (value === "on" || value === "off")) {
			update = { preview: value === "on" };
		} else if (extra === undefined && key === "rows") {
			const previewRows = parseRows(value);
			if (previewRows !== undefined) update = { previewRows };
		} else if (extra === undefined && key === "color") {
			const tokenColor = parseColor(rawValue);
			if (tokenColor && !tokenColor.startsWith("#")) {
				try {
					context.ui.theme.fg(tokenColor as ThemeColor, "");
				} catch {
					context.ui.notify(`Unknown theme color: ${tokenColor}. Use a Pi theme color such as warning or accent, or #rrggbb.`, "error");
					return true;
				}
			}
			if (tokenColor) update = { tokenColor };
		}
		if (!update) {
			context.ui.notify(`Usage: /image-store [stats | gc | ${PASTE_USAGE}]`, "warning");
			return true;
		}
		try {
			writeSettings(settingsPath, update);
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : "Image settings could not be saved.", "error");
			return true;
		}
		settings = { ...settings, ...update };
		tui?.invalidate();
		requestRender();
		context.ui.notify(describeSettings(), "info");
		return true;
	};

	return { command, show };
}
